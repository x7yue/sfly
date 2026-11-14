// 命令行的运行输出带上显示名称（#319，spec #277）：`sfly run start --wait` / `run wait` 的摘要和进度行、`run show` 的节点表。
// 节点 ID 在前、显示名称在后（输出常被拿去拼下一条命令）；`run logs` 的每一行不变。
// 真实的 sfly 进程对着测试控制面，运行的成功、失败由假 Agent 产生。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { type SflyProcess, spawnSfly } from "./support/sfly-process.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const cells = (line: string) => line.trim().split(/ {2,}/);
const lines = (stdout: string) => stdout.trimEnd().split("\n");

describe("sfly 运行输出里的显示名称 → 控制面", { timeout: 60_000 }, () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = new ManualClock();
	const processes: SflyProcess[] = [];
	let agents = 0;

	/** 主链：a（有显示名称，重试 1 次）→ b（没有显示名称，上一个失败了也要执行）。 */
	const scenario = async (name: string) => {
		const nodes = [
			{ id: "entry", kind: "entry", params: [] },
			{ ...echo("a"), display_name: "创建测试用户", retries: 1 },
			{ ...echo("b"), always: true },
		];
		return api.orchestrationWith(
			{
				default_agent: agent.name,
				nodes,
				edges: [
					{ from: "entry", to: "a", kind: "chain" },
					{ from: "a", to: "b", kind: "chain" },
				],
				packages: { stub: "1.0.0" },
			},
			name,
		);
	};
	const assign = () => agent.nextAssign({ timeoutMs: 30_000 });
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const start = (...args: string[]): SflyProcess => {
		const process = spawnSfly([...args, "--server", cp.httpUrl]);
		processes.push(process);
		return process;
	};
	const runOf = async (scenarioId: string): Promise<string> => {
		let id = "";
		await eventually(async () => {
			const { runs } = await api.getJson<{ runs: Array<{ id: string }> }>(
				`/orchestrations/${scenarioId}/runs`,
			);
			expect(runs).toHaveLength(1);
			id = runs[0]?.id ?? "";
		}, 20_000);
		return id;
	};

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock, leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	}, 120_000);
	beforeEach(async () => {
		agent = await FakeAgent.connect(cp.grpcUrl, { name: `agent-${++agents}`, slots: 4 });
	});
	afterEach(async () => {
		for (const process of processes.splice(0)) process.kill();
		await agent.disconnect();
	});
	afterAll(async () => {
		await cp?.close();
	});

	/** 跑完一次运行：a 失败、重试后再失败（第二次带 60 行日志，最后一行是「登录失败」），b 失败。 */
	async function failedRun(name: string): Promise<{ runId: string; waiting: SflyProcess }> {
		const id = await scenario(name);
		const waiting = start("run", "start", name, "--wait");
		await agent.fail(await assign(), "第一次失败");
		const second = await assign();
		agent.logs(
			second,
			Array.from({ length: 60 }, (_, i): [number, string] => [
				i + 1,
				i === 59 ? "登录失败" : `日志第 ${i + 1} 行`,
			]),
		);
		await agent.sync();
		clock.advance(3_000);
		await agent.fail(second, "第二次失败");
		await agent.fail(await assign(), "b 也失败");
		return { runId: await runOf(id), waiting };
	}

	describe("摘要和进度行", () => {
		it("失败的任务写成 链:节点「显示名称」（类型，第 n 次尝试），没有显示名称的节点不变；进度行同样", async () => {
			const { runId, waiting } = await failedRun("摘要场景");

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(1);
			expect(lines(result.stdout)).toEqual(
				expect.arrayContaining([
					"  main:a#1「创建测试用户」（stub/echo，第 1 次尝试）",
					"  main:a#2「创建测试用户」（stub/echo，第 2 次尝试）",
					"  main:b（stub/echo，第 1 次尝试）",
				]),
			);
			// 提示里接下来要用的命令，节点不带名称。
			expect(lines(result.stdout)).toContain(
				`    （前面还有更早的日志，用 sfly run logs ${runId} --node main:a 查看）`,
			);
			expect(lines(result.stderr)).toEqual(
				expect.arrayContaining(["main:a#2「创建测试用户」 失败 3.0s", "main:b 失败 0.0s"]),
			);

			const waited = await cli("run", "wait", runId);
			expect(waited.code, waited.stderr).toBe(1);
			expect(lines(waited.stdout)).toEqual(
				expect.arrayContaining(["  main:a#1「创建测试用户」（stub/echo，第 1 次尝试）"]),
			);
		});

		it("--json：失败的任务带 display_name，没有显示名称的不带", async () => {
			const { runId, waiting } = await failedRun("摘要 JSON 场景");
			await waiting.exited;

			const json = await cli("run", "wait", runId, "--json");
			expect(json.code, json.stderr).toBe(1);
			const summary = JSON.parse(json.stdout) as {
				failed: Array<Record<string, unknown>>;
			};
			expect(summary.failed.map((f) => [f.node, f.attempt, f.display_name])).toEqual([
				["a", 1, "创建测试用户"],
				["a", 2, "创建测试用户"],
				["b", 1, undefined],
			]);
			expect(summary.failed[2]).not.toHaveProperty("display_name");
			expect(summary.failed[0]).toMatchObject({ chain: "main", node: "a", type: "stub/echo" });
		});

		it("子流程里的节点：链写子流程名称，节点后面是它的显示名称", async () => {
			const id = await api.orchestrationWith(
				{
					...orchestration(
						[
							[{ id: "entry", kind: "entry", params: [] }, spawn("go")],
							[
								{ id: "sub", kind: "subflow_entry", name: "report", params: [] },
								{ ...echo("send"), display_name: "发送报告" },
							],
						],
						[["go", "sub"]],
					),
					default_agent: agent.name,
				},
				"子流程场景",
			);
			const waiting = start("run", "start", "子流程场景", "--wait");
			await agent.fail(await assign(), "子流程里失败");

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(1);
			expect(lines(result.stdout)).toContain("  report:send「发送报告」（stub/echo，第 1 次尝试）");
			expect(lines(result.stderr)).toContain("report:send「发送报告」 失败 0.0s");
			expect((await api.run(await runOf(id))).status).toBe("failed");
		});
	});

	describe("run show", () => {
		it("节点表和失败节点一节：节点 ID 在前、显示名称在后；--json 的节点带 display_name", async () => {
			const { runId, waiting } = await failedRun("查看场景");
			await waiting.exited;

			const shown = await cli("run", "show", runId);
			expect(shown.code, shown.stderr).toBe(0);
			const out = lines(shown.stdout);
			expect(out.map(cells)).toEqual(
				expect.arrayContaining([
					["节点", "状态", "尝试", "Agent", "耗时"],
					["a「创建测试用户」", "失败", "2", agent.name, "3.0s"],
					["b", "失败", "1", agent.name, "0.0s"],
				]),
			);
			expect(out).toEqual(
				expect.arrayContaining([
					"  main:a「创建测试用户」  失败，共 2 次尝试",
					"  main:b  失败，共 1 次尝试",
				]),
			);

			const json = JSON.parse((await cli("run", "show", runId, "--json")).stdout) as {
				chains: Array<{ nodes: Array<Record<string, unknown>> }>;
			};
			const [entry, a, b] = json.chains[0]?.nodes ?? [];
			expect(entry).not.toHaveProperty("display_name");
			expect(a).toMatchObject({ id: "a", display_name: "创建测试用户" });
			expect(b).not.toHaveProperty("display_name");
		});
	});

	describe("run logs", () => {
		it("每一行的格式不变：时间 级别 链:节点#尝试 内容，不带显示名称", async () => {
			const { runId, waiting } = await failedRun("日志场景");
			await waiting.exited;

			const logs = await cli("run", "logs", runId);
			expect(logs.code, logs.stderr).toBe(0);
			expect(lines(logs.stdout).filter((l) => l.includes("登录失败"))).toEqual([
				expect.stringMatching(/^\S+ info {2}main:a#2 登录失败$/),
			]);
			expect(logs.stdout).not.toContain("创建测试用户");
		});
	});
});
