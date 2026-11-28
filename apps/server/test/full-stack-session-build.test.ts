// 会话构建能否不改 Agent 和协议（#456）：版本号带本地标签（`0.3.1+s<会话>.<序号>`）的节点包，用现有的 sfly build、
// sfly publish 发布，经现有的派发链路到真实 Agent 上下载、安装、执行；和正式版本交替使用、Agent 重启之后都执行锁定的那个版本。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApiClient, type AttemptView } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "session-demo";
const AGENT = "session-agent";
const RELEASE = "0.3.1";
const SESSION_1 = "0.3.1+s3f9a.1";
const SESSION_2 = "0.3.1+s3f9a.2";

interface AgentInfo {
	name: string;
	installed_packages: Array<{ name: string; version: string }>;
	install: { package: string; version: string; state: string } | null;
}

/** 每一步的耗时（毫秒），最后打一行。 */
const timings: Record<string, number> = {};

describeWithAgent("会话构建：带本地版本标签的节点包经现有链路发布、派发、安装、执行", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let dir: string;
	let scenario: string;

	/** 写一个版本的源码（节点返回这个版本自己的标记），sfly build、sfly publish（发布构建好的归档），分别计时。 */
	const publish = async (version: string) => {
		const src = join(dir, `src-${version}`);
		await mkdir(join(src, "src", "session_demo"), { recursive: true });
		await writeFile(
			join(src, "pyproject.toml"),
			`[project]\nname = "${PACKAGE}"\nversion = "${version}"\ndependencies = []\n`,
		);
		await writeFile(join(src, "src", "session_demo", "__init__.py"), "");
		await writeFile(
			join(src, "src", "session_demo", "which.py"),
			[
				"from sfly import Context, node",
				"",
				'@node(title="哪一版", outputs=["code"])',
				"def which(ctx: Context) -> dict:",
				`    return {"code": ${JSON.stringify(version)}}`,
				"",
			].join("\n"),
		);
		const out = join(dir, `out-${version}`);
		let started = performance.now();
		const built = await sfly(["build", src, "--out", out]);
		expect(built.code, built.stderr).toBe(0);
		timings[`build ${version}`] = Math.round(performance.now() - started);
		started = performance.now();
		const archive = join(out, `${PACKAGE}-${version}.sflypkg`);
		const published = await sfly(["publish", archive, "--server", cp.httpUrl]);
		expect(published.code, published.stderr).toBe(0);
		timings[`publish ${version}`] = Math.round(performance.now() - started);
		expect(published.stdout).toContain(`${PACKAGE}@${version}`);
	};

	/** 场景改锁这个版本（保存新版本）。 */
	const lock = (version: string) =>
		api.saveVersion(scenario, {
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: PACKAGE, node: "which", inputs: {} },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { [PACKAGE]: version },
		});

	/** 跑一次，返回执行出的标记、这次尝试和从触发到看到成功的毫秒数（要安装时包括安装）。 */
	const runOnce = async (): Promise<{ code: unknown; attempt: AttemptView; ms: number }> => {
		const started = performance.now();
		const runId = await api.triggerOk(scenario);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
		const ms = Math.round(performance.now() - started);
		const node = await api.node(runId, "a");
		return { code: node.outputs?.code, attempt: node.attempts[0] as AttemptView, ms };
	};

	const agentInfo = async () => {
		const { agents } = await api.getJson<{ agents: AgentInfo[] }>("/projects/default/agents");
		const found = agents.find((a) => a.name === AGENT);
		if (!found) throw new Error(`agent ${AGENT} not registered`);
		return found;
	};
	const installed = async () =>
		(await agentInfo()).installed_packages.filter((p) => p.name === PACKAGE);

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-session-build-"));
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		api = new ApiClient(cp);
		scenario = await api.createOrchestration("会话构建");
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: AGENT, venv: venv.path });
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
		console.info(`#456 耗时（毫秒）：${JSON.stringify(timings)}`);
	});

	it("1. 版本号带本地标签的节点包用 sfly build、sfly publish 发布，控制面按原样记下版本号", async () => {
		await publish(SESSION_1);
		const view = await api.getJson<{ version: string; sha256: string }>(
			`/projects/default/packages/${PACKAGE}/versions/${encodeURIComponent(SESSION_1)}`,
		);
		expect(view.version).toBe(SESSION_1);
	}, 120_000);

	it("2. 场景锁定它，派发到没有装过它的 Agent：下载、安装、执行成功", async () => {
		expect(await installed()).toEqual([]);
		await lock(SESSION_1);
		const { code, attempt, ms } = await runOnce();
		expect(code).toBe(SESSION_1);
		expect(attempt.agent).toBe(AGENT);
		timings[`运行（要安装 ${SESSION_1}）`] = ms;
		expect(await installed()).toEqual([{ name: PACKAGE, version: SESSION_1 }]);
		expect((await agentInfo()).install).toMatchObject({ version: SESSION_1, state: "installed" });

		// 再跑一次不再安装：这是不装时的基线。
		const again = await runOnce();
		expect(again.code).toBe(SESSION_1);
		timings["运行（已装好）"] = again.ms;
	}, 240_000);

	it("3. 同一个包再发一个序号更大的标签版本，场景改锁它：Agent 换装新版本，执行的是新代码", async () => {
		await publish(SESSION_2);
		await lock(SESSION_2);
		const { code, ms } = await runOnce();
		expect(code).toBe(SESSION_2);
		timings[`运行（换装 ${SESSION_2}）`] = ms;
		expect(await installed()).toEqual([{ name: PACKAGE, version: SESSION_2 }]);
	}, 240_000);

	it("4. 正式版本和标签版本交替使用：每次执行的都是锁定的那个版本的代码", async () => {
		await publish(RELEASE);
		for (const [i, version] of [RELEASE, SESSION_1, RELEASE, SESSION_2, SESSION_1].entries()) {
			await lock(version);
			const { code, ms } = await runOnce();
			expect(code, `锁定 ${version}`).toBe(version);
			expect(await installed()).toEqual([{ name: PACKAGE, version }]);
			timings[`运行（交替第 ${i + 1} 次，换装 ${version}）`] = ms;
		}
	}, 600_000);

	it("5. Agent 重启后上报的已安装版本里标签版本原样出现；锁定它时不重装，换锁别的版本时重装", async () => {
		// 第 4 步最后锁定、装着的是 SESSION_1。
		await agent.close();
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: AGENT, venv: venv.path });
		await eventually(async () => expect((await agentInfo()).install).toBeNull());
		expect(await installed()).toEqual([{ name: PACKAGE, version: SESSION_1 }]);

		const kept = await runOnce();
		expect(kept.code).toBe(SESSION_1);
		timings["运行（重启后已装好）"] = kept.ms;
		// 这次连接没有装过节点包。
		expect((await agentInfo()).install).toBeNull();

		await lock(SESSION_2);
		const switched = await runOnce();
		expect(switched.code).toBe(SESSION_2);
		timings[`运行（重启后换装 ${SESSION_2}）`] = switched.ms;
		expect((await agentInfo()).install).toMatchObject({ version: SESSION_2, state: "installed" });
		expect(await installed()).toEqual([{ name: PACKAGE, version: SESSION_2 }]);
	}, 300_000);
});
