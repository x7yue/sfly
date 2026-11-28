// 同一台 Agent 上同一个节点包的两个版本不能同时用（#449）：Agent 的共享 venv 一个包只装一个版本，任务执行期间不持锁，
// 后到的版本装上时会换掉正在执行的那个任务的代码。经真实控制面和真实 Agent：先到的任务等着、之后才导入模块，
// 另一个版本被拒（触发时预检阻断；绕过预检时派发失败），先到的任务导入到的还是自己的代码。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { sfly } from "./support/sfly-cli.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "conflict-demo";
const AGENT = "conflict-agent";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

describeWithAgent("同一台 Agent 上同一个节点包的另一个版本正在执行", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let dir: string;

	/**
	 * 发布一个版本：`hold` 等 `gate` 文件出现之后才导入 `marker`、返回它的版本号（模拟执行到一半才导入模块的节点），
	 * `quick` 立即返回。
	 */
	const publish = async (version: string) => {
		const src = join(dir, `src-${version}`);
		const pkg = join(src, "src", "conflict_demo");
		await mkdir(pkg, { recursive: true });
		await writeFile(
			join(src, "pyproject.toml"),
			`[project]\nname = "${PACKAGE}"\nversion = "${version}"\ndependencies = []\n`,
		);
		await writeFile(join(pkg, "__init__.py"), "");
		await writeFile(join(pkg, "marker.py"), `CODE = ${JSON.stringify(version)}\n`);
		await writeFile(
			join(pkg, "nodes.py"),
			[
				"import importlib",
				"import os",
				"import time",
				"from sfly import Context, node",
				"",
				'@node(title="等着", outputs=["code"])',
				"def hold(ctx: Context, gate: str) -> dict:",
				"    while not os.path.exists(gate):",
				"        time.sleep(0.05)",
				'    return {"code": importlib.import_module("conflict_demo.marker").CODE}',
				"",
				'@node(title="立即", outputs=["code"])',
				"def quick(ctx: Context) -> dict:",
				'    return {"code": importlib.import_module("conflict_demo.marker").CODE}',
				"",
			].join("\n"),
		);
		const published = await sfly(["publish", src, "--server", cp.httpUrl]);
		expect(published.code, published.stderr).toBe(0);
	};

	const scenario = (version: string, node: "hold" | "quick") =>
		api.orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: node === "hold" ? [{ name: "gate", type: "string", required: true }] : [],
				},
				{
					id: "a",
					kind: "package",
					package: PACKAGE,
					node,
					inputs: node === "hold" ? { gate: "${{ params.gate }}" } : {},
				},
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { [PACKAGE]: version },
		});
	const status = async (runId: string) => (await api.run(runId)).status;
	const nodeOf = (runId: string) => api.node(runId, "a");
	const installed = async () => {
		const { agents } = await api.getJson<{
			agents: Array<{ name: string; installed_packages: Array<{ name: string; version: string }> }>;
		}>("/projects/default/agents");
		return agents
			.find((a) => a.name === AGENT)
			?.installed_packages.filter((p) => p.name === PACKAGE)
			.map((p) => p.version);
	};
	const startAgent = () =>
		startRealAgent({ grpcUrl: cp.grpcUrl, name: AGENT, venv: venv.path, args: ["--slots", "4"] });

	let hold10: string;
	let quick11: string;

	beforeAll(async () => {
		dir = await makeTempDir("sfly-version-conflict-");
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		api = new ApiClient(cp);
		await publish("1.0");
		await publish("1.1");
		hold10 = await scenario("1.0", "hold");
		quick11 = await scenario("1.1", "quick");
		agent = await startAgent();
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("1.0 的任务在执行时触发用 1.1 的场景：被预检阻断，1.0 的任务导入到的还是 1.0 的代码；它结束之后同样的触发成功", async () => {
		const gate = join(dir, "gate-1");
		const first = await api.triggerOk(hold10, { gate });
		await eventually(async () => expect((await nodeOf(first)).status).toBe("running"), 60_000);

		const second = await api.trigger(quick11, {});
		// 改之前这里会触发成功：1.1 装进共享 venv，换掉 1.0 的任务还没导入的模块。等它跑完再放行 1.0 的任务。
		const secondRun =
			second.status === 201 ? ((await second.clone().json()) as { id: string }).id : undefined;
		if (secondRun) {
			await eventually(async () => expect(await status(secondRun)).not.toBe("running"), 60_000);
		}
		await writeFile(gate, "");
		await eventually(async () => expect(await status(first)).toBe("success"), 60_000);
		expect((await nodeOf(first)).outputs).toEqual({ code: "1.0" });

		expect(second.status).toBe(400);
		const { error } = (await second.json()) as { error: { code: string; details: Problem[] } };
		expect(error.code).toBe("invalid_orchestration");
		const conflict = error.details.find((p) => p.code === "package_version_in_use");
		expect(conflict?.message).toContain(`Agent ${AGENT}`);
		expect(conflict?.message).toContain(`${PACKAGE}@1.0`);
		expect(conflict?.message).toContain(first);
		expect(await installed()).toEqual(["1.0"]);

		const later = await api.triggerOk(quick11);
		await eventually(async () => expect(await status(later)).toBe("success"), 60_000);
		expect((await nodeOf(later)).outputs).toEqual({ code: "1.1" });
	}, 300_000);

	it("绕过预检（两个运行都在 Agent 离线时触发）：后派发的那个以 env_error 失败，不动 Agent 上的环境，先派发的照常执行", async () => {
		await agent.close();
		await eventually(async () => {
			const { agents } = await api.getJson<{ agents: Array<{ name: string; status: string }> }>(
				"/projects/default/agents",
			);
			expect(agents.find((a) => a.name === AGENT)?.status).toBe("offline");
		});
		const gate = join(dir, "gate-2");
		const first = await api.triggerOk(hold10, { gate });
		const second = await api.triggerOk(quick11);
		agent = await startAgent();

		await eventually(async () => expect(await status(second)).toBe("failed"), 60_000);
		const failed = await nodeOf(second);
		expect(failed.attempts).toHaveLength(1);
		expect(failed.attempts[0]?.error?.kind).toBe("env_error");
		expect(failed.attempts[0]?.error?.message).toContain(`${PACKAGE}@1.0`);
		expect(failed.attempts[0]?.error?.message).toContain(first);
		await eventually(async () => expect((await nodeOf(first)).status).toBe("running"), 60_000);
		expect(await installed()).toEqual(["1.0"]);

		await writeFile(gate, "");
		await eventually(async () => expect(await status(first)).toBe("success"), 60_000);
		expect((await nodeOf(first)).outputs).toEqual({ code: "1.0" });
	}, 300_000);
});
