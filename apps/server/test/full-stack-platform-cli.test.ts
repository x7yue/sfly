// 全栈（#248，规格 #238 的验收）：AI 编程助手只用 sfly 命令行走完联调闭环。
// 真实的控制面、真实的 Rust Agent 和真实的 sfly 进程（环境里带着 AI 编程助手的标记），按 sfly-platform skill 的步骤：
// sfly dev 把节点包装到本机 Agent → scenario copy 复制场景 → scenario pull，改成开发版本和本机 Agent →
// scenario push → run start --wait。节点先故意失败：退出码 1，摘要里有失败节点的错误和日志尾部；
// 改好代码再运行（沿用同一份副本、不用重新 sfly dev）：退出码 0。
// 节点包是测试里现写的小项目（loop-demo），原场景锁定它已发布的版本、跑在另一台 Agent 上。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { type SflyResult, sfly } from "./support/sfly-cli.js";
import { publishArchive } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const run = promisify(execFile);

const PACKAGE = "loop-demo";
const NODE = "probe";
/** 本机 Agent：skill 要求的名称 `dev-<用户名>-<主机名>`。 */
const LOCAL_AGENT = "dev-tester-box";
const PROD_AGENT = "prod-agent";
const NICKNAME = "测试员";
const ORIGINAL = "回归";
const COPY = `${ORIGINAL}-联调-${NICKNAME}`;

const PYPROJECT = `[project]
name = "${PACKAGE}"
version = "0.1.0"
dependencies = []

[tool.sfly]
requires-sdk = ">=0.0.0"
`;

const MODULE_HEAD = `from typing import TypedDict

from sfly import Context, Metric, node


class Probe(TypedDict):
    status: int
    latency_ms: int


@node(
    title="探测服务",
    metrics=[Metric("latency", unit="ms", kind="gauge", description="探测延迟")],
    primary_metric="latency",
)
def probe(ctx: Context, host: str) -> Probe:
    ctx.log.info("开始探测 %s", host)
`;

const FAILING_BODY = `    ctx.log.warning("%s 的后端池是空的", host)
    raise RuntimeError(f"{host} 返回 503")
`;

const FIXED_BODY = `    ctx.metric("latency", 12)
    ctx.log.info("%s 返回 200", host)
    return {"status": 200, "latency_ms": 12}
`;

describe("全栈：AI 编程助手只用 sfly 命令行走完联调闭环", () => {
	let dir: string;
	let project: string;
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: RealAgent;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let prod: FakeAgent;
	let originalId: string;
	let originalVersions: number;
	let copyId = "";
	let failedRun = "";
	let file = "";

	const source = () => join(project, "src", "loop_demo", "__init__.py");
	const cli = (args: string[]): Promise<SflyResult> =>
		sfly(args, {
			env: { SFLY_SERVER: cp.httpUrl, SFLY_NICKNAME: NICKNAME, CLAUDECODE: "1" },
		});
	const ok = async (args: string[]) => {
		const result = await cli(args);
		expect(result.code, `sfly ${args.join(" ")}\n${result.stderr}`).toBe(0);
		return result;
	};

	/** 联调副本上某个状态的运行 id。 */
	const runIds = async (status: string): Promise<string[]> =>
		(
			JSON.parse(
				(await ok(["run", "list", "--scenario", COPY, "--status", status, "--json"])).stdout,
			) as Array<{ id: string }>
		).map((r) => r.id);

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await mkdtemp(join(tmpdir(), "sfly-full-platform-cli-"));
		project = join(dir, PACKAGE);
		file = join(dir, "联调.scenario.json");
		await mkdir(join(project, "src", "loop_demo"), { recursive: true });
		await writeFile(join(project, "pyproject.toml"), PYPROJECT);
		await writeFile(source(), MODULE_HEAD + FAILING_BODY);

		[cp, venv] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
			createStubVenv({ sdkOnly: true }),
		]);
		api = new ApiClient(cp);
		// sfly dev 装开发版本时不访问外网：节点包没有依赖，给一个不存在的镜像。
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: LOCAL_AGENT,
			venv: venv.path,
			args: ["--index-url", "http://127.0.0.1:9/simple/"],
			bin,
		});
		prod = await FakeAgent.connect(cp.grpcUrl, { name: PROD_AGENT });

		// 原场景：锁定已发布的 loop-demo@0.1.0，跑在另一台 Agent 上。
		const out = join(dir, "dist");
		await run("uv", ["run", "--locked", "--quiet", "sfly", "build", project, "--out", out], {
			cwd: repoRoot,
		});
		await publishArchive(cp, await readFile(join(out, `${PACKAGE}-0.1.0.sflypkg`)));
		originalId = await api.orchestrationWith(
			{
				default_agent: PROD_AGENT,
				nodes: [
					{ id: "entry", kind: "entry", params: [] },
					{
						id: NODE,
						kind: "package",
						package: PACKAGE,
						node: NODE,
						inputs: { host: "api.test" },
					},
				],
				edges: [{ from: "entry", to: NODE, kind: "chain" }],
				packages: { [PACKAGE]: "0.1.0" },
			},
			ORIGINAL,
		);
		originalVersions = await api.headVersion(originalId);
	}, 600_000);

	afterAll(async () => {
		await prod?.disconnect();
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("sfly dev 把节点包装到本机 Agent，agent list 里本机 Agent 在线、版本一致、列出开发包", async () => {
		const dev = await ok(["dev", project, "--socket", join(agent.workDir, "tasks", "agent.sock")]);
		expect(dev.stdout).toContain(`${PACKAGE}@dev`);

		await eventually(async () => {
			const rows = (await ok(["agent", "list"])).stdout
				.trimEnd()
				.split("\n")
				.map((line) => line.split(/\s{2,}/));
			expect(rows[0]).toContain("与控制面一致");
			expect(rows.find((row) => row[0] === LOCAL_AGENT)).toEqual([
				LOCAL_AGENT,
				"在线",
				cp.version,
				"是",
				expect.stringMatching(/^0\/\d+$/),
				expect.any(String),
				PACKAGE,
			]);
		}, 30_000);
	}, 120_000);

	it("scenario copy：副本名称是 <原名>-联调-<昵称>，原场景不变", async () => {
		const copied = await ok(["scenario", "copy", ORIGINAL, "--name", COPY]);
		expect(copied.stdout).toContain(`「${COPY}」`);

		const listed = await ok(["scenario", "list", "--search", `${ORIGINAL}-联调`, "--json"]);
		expect(JSON.parse(listed.stdout)).toMatchObject([{ name: COPY, head_version: 1 }]);
		expect(await api.headVersion(originalId)).toBe(originalVersions);
	});

	it("scenario pull，改成开发版本和本机 Agent，push：新版本经 Claude Code 保存，原场景不变", async () => {
		await ok(["scenario", "pull", COPY, "-o", file]);
		const content = JSON.parse(await readFile(file, "utf8")) as {
			scenario: string;
			base_version: number;
			document: { default_agent: string; packages: Record<string, string> };
		};
		expect(content).toMatchObject({
			base_version: 1,
			document: { default_agent: PROD_AGENT, packages: { [PACKAGE]: "0.1.0" } },
		});
		copyId = content.scenario;
		content.document.packages[PACKAGE] = "dev";
		content.document.default_agent = LOCAL_AGENT;
		await writeFile(file, JSON.stringify(content, null, 2));

		const pushed = await ok(["scenario", "push", file]);
		expect(pushed.stdout).toContain("版本 2");

		const versions = await ok(["scenario", "versions", COPY]);
		expect(versions.stdout).toContain("经 Claude Code");
		const view = await api.getJson<{ author: string; author_via: string }[]>(
			`/orchestrations/${copyId}/versions`,
		);
		expect(JSON.stringify(view)).toContain("claude-code");
		expect(await api.headVersion(originalId)).toBe(originalVersions);
	});

	it("run start --wait：节点故意失败，退出码 1，摘要里有失败节点的错误和日志尾部", async () => {
		const failed = await cli(["run", "start", COPY, "--wait", "--timeout", "120s"]);
		expect(failed.code, failed.stderr).toBe(1);
		// 进度写在 stderr，一行一条。
		expect(failed.stderr).toContain("main:probe");
		// 摘要：失败的节点（节点类型）、错误、日志尾部，和运行 id。
		failedRun = (await runIds("failed"))[0] ?? "";
		for (const text of [
			failedRun,
			"main:probe",
			`${PACKAGE}/${NODE}`,
			"api.test 返回 503",
			"开始探测 api.test",
			"api.test 的后端池是空的",
		]) {
			expect(failed.stdout).toContain(text);
		}

		const run = await api.run(failedRun);
		expect(run).toMatchObject({
			status: "failed",
			triggered_by: NICKNAME,
			triggered_via: "claude-code",
		});
		const node = await api.node(failedRun, NODE);
		expect(node.status).toBe("failed");
		expect(node.agent).toBe(LOCAL_AGENT);

		// 需要更多日志时按失败任务读。
		const logs = await ok(["run", "logs", failedRun, "--failed"]);
		expect(logs.stdout).toContain("main:probe");
		expect(logs.stdout).toContain("api.test 返回 503");
	}, 180_000);

	it("改好代码再运行（沿用同一份副本，不用重新 sfly dev）：退出码 0，输出、日志、指标符合预期", async () => {
		await writeFile(source(), MODULE_HEAD + FIXED_BODY);

		const passed = await cli(["run", "start", COPY, "--wait", "--timeout", "120s"]);
		expect(passed.code, passed.stderr).toBe(0);
		const runId = (await runIds("success"))[0] ?? "";
		expect(passed.stdout).toContain(runId);
		expect(passed.stdout).not.toContain("api.test 返回 503");

		expect(await api.node(runId, NODE)).toMatchObject({
			status: "success",
			outputs: { status: 200, latency_ms: 12 },
		});
		const logs = await ok(["run", "logs", runId]);
		expect(logs.stdout).toContain("api.test 返回 200");

		// skill 教的核对方式：节点输出和指标摘要用 sfly api 读。
		const detail = JSON.parse((await ok(["api", "GET", `/runs/${runId}`])).stdout) as {
			chains: Array<{ nodes: Array<{ node_id: string; outputs: unknown }> }>;
		};
		expect(detail.chains[0]?.nodes.find((n) => n.node_id === NODE)?.outputs).toEqual({
			status: 200,
			latency_ms: 12,
		});
		const metrics = JSON.parse((await ok(["api", "GET", `/runs/${runId}/metrics/summary`])).stdout);
		expect(metrics).toMatchObject({
			tasks: [{ node_id: NODE, metrics: [{ name: "latency", points: 1, last: 12 }] }],
		});

		// 两次运行都在这份副本上，原场景没有被触发。
		const listed = JSON.parse((await ok(["run", "list", "--scenario", COPY, "--json"])).stdout);
		expect(listed.map((r: { id: string }) => r.id).sort()).toEqual([failedRun, runId].sort());
		expect(
			JSON.parse((await ok(["run", "list", "--scenario", ORIGINAL, "--json"])).stdout),
		).toEqual([]);
	}, 180_000);

	it("没有可复制的场景时：skill 里的最小场景文档 scenario create --from 新建联调副本，运行成功", async () => {
		const skill = await readFile(
			join(repoRoot, "docs/guide/skills/sfly-platform/SKILL.md"),
			"utf8",
		);
		const template = /^ *```json\n([\s\S]*?)^ *```$/m.exec(skill)?.[1] ?? "";
		const created = JSON.parse(
			template
				.replaceAll("<本机 Agent>", LOCAL_AGENT)
				.replaceAll("<包名>", PACKAGE)
				.replaceAll("<节点 id>", "probe")
				.replaceAll("<节点名>", NODE),
		) as { document: { nodes: Array<{ id: string; inputs?: Record<string, unknown> }> } };
		const probe = created.document.nodes.find((n) => n.id === "probe");
		if (probe) probe.inputs = { host: "api.test" };
		const fresh = join(dir, "新建.scenario.json");
		await writeFile(fresh, JSON.stringify(created));
		const name = `${PACKAGE}-联调-${NICKNAME}`;

		const result = await ok(["scenario", "create", "--name", name, "--from", fresh]);
		expect(result.stdout).toContain(`已新建场景「${name}」`);
		const shown = await ok(["scenario", "show", name]);
		expect(shown.stdout).toContain(`${PACKAGE}/${NODE}`);
		expect(shown.stdout).toContain("dev");

		const passed = await cli(["run", "start", name, "--wait", "--timeout", "120s"]);
		expect(passed.code, `${passed.stdout}\n${passed.stderr}`).toBe(0);
	}, 180_000);
});
