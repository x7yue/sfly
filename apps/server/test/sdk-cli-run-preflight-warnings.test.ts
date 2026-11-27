// sfly run start 输出预检的警告（#421）：不阻断触发的警告（异步任务节点没有给子流程的参数传值）写在触发之后的输出里，
// 和控制台的触发对话框读的是同一份预检结果（`GET /orchestrations/:id/preflight` 的 warnings）。
// 阻断的问题（开发版本没有加载、值接到类型不符的输入）和以前一样：预检的问题退出码 2；入口参数的问题报「入口参数不对」，
// 值接到类型不符的输入时标题改说实际的问题（#444）。
// 真实的 sfly 进程对测试控制面，运行由假 Agent 接收。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { withSecretLimits } from "./support/secret-limits.js";
import { sfly } from "./support/sfly-cli.js";
import { type SflyProcess, spawnSfly } from "./support/sfly-process.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const WARNING_CODE = "subflow_param_not_passed";

describe("sfly run start 的预检警告 → 控制面", { timeout: 60_000 }, () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const processes: SflyProcess[] = [];
	let scenes = 0;

	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const start = (...args: string[]): SflyProcess => {
		const process = spawnSfly([...args, "--server", cp.httpUrl]);
		processes.push(process);
		return process;
	};

	/** 主链异步任务节点触发子流程，子流程声明可选参数 host 并用到它；`mapping` 是异步任务节点的参数映射。 */
	const scenario = async (mapping: Record<string, unknown>) => {
		const name = `警告场景-${++scenes}`;
		const spawned = { ...spawn("spawn", mapping), display_name: "派发汇报" };
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawned],
					[
						{ id: "sub", kind: "subflow_entry", name: "汇报", params: [param("host")] },
						echo("clean", { v: "${{ params.host }}" }),
					],
				],
				[["spawn", "sub"]],
			),
			name,
		);
		return { id, name };
	};
	const runsOf = async (scenarioId: string) =>
		(
			await api.getJson<{ runs: Array<{ id: string }> }>(`/orchestrations/${scenarioId}/runs`)
		).runs.map((r) => r.id);

	const WARNING_LINES = [
		"警告（1）：不影响触发，运行已经触发",
		`  - ${WARNING_CODE}：节点 派发汇报（spawn） 没有给子流程 汇报（sub） 的参数 host 传值，子流程里的节点 clean 用到了它，拿到的会是空值（null）：在这个节点的参数映射里给 host 传值，或者在子流程入口节点给它设默认值`,
	];

	beforeAll(async () => {
		cp = await startTestControlPlane();
		// spawnSfly 同步起进程：先建好 tester 的用户和令牌。
		await cp.users.user();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await publishPackage(cp, "tuner", "1.0.0", {
			tune: { outputs: [], inputs: { properties: { n: { type: "integer" } }, required: ["n"] } },
		});
	}, 120_000);
	// orchestration() 的默认 Agent 写死了 agent-a。
	beforeEach(async () => {
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		for (const process of processes.splice(0)) process.kill();
		await agent.disconnect();
	});
	afterAll(async () => {
		await cp?.close();
	});

	it("预检有警告但不阻断：运行照常触发，文本输出在链接和「等它结束」之间写出警告", async () => {
		const { id, name } = await scenario({});

		const result = await cli("run", "start", name);
		expect(result.code, result.stderr).toBe(0);
		const [runId] = await runsOf(id);
		expect(result.stdout).toBe(
			[
				`已触发运行 ${runId}`,
				`链接：${cp.httpUrl}/runs/${runId}`,
				...WARNING_LINES,
				`等它结束：sfly run wait ${runId}`,
				"",
			].join("\n"),
		);
		expect(result.stderr).toBe("");
	});

	it("--json：stdout 的对象带 warnings，警告和下一步提示写到 stderr", async () => {
		const { id, name } = await scenario({});

		const result = await cli("run", "start", name, "--json");
		expect(result.code, result.stderr).toBe(0);
		const [runId] = await runsOf(id);
		const started = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(started).toEqual({
			id: runId,
			status: "running",
			scenario_id: id,
			scenario_version: 1,
			url: `${cp.httpUrl}/runs/${runId}`,
			warnings: [
				{
					code: WARNING_CODE,
					node_id: "spawn",
					message: WARNING_LINES[1]?.replace(`  - ${WARNING_CODE}：`, ""),
				},
			],
		});
		expect(result.stderr).toBe(
			[...WARNING_LINES, `等它结束：sfly run wait ${runId}`, ""].join("\n"),
		);
	});

	it("--wait：警告写在 stderr 的「已触发运行」之后，stdout 仍然只有摘要", async () => {
		const { id, name } = await scenario({});
		const waiting = start("run", "start", name, "--wait");

		const task = await agent.nextAssign({ timeoutMs: 30_000 });
		await agent.succeed(task);
		const result = await waiting.exited;
		expect(result.code, result.stderr).toBe(0);
		const [runId] = await runsOf(id);
		expect(result.stdout).toContain(`运行 ${runId}：成功`);
		expect(result.stdout).not.toContain("警告");
		expect(result.stderr.split("\n").slice(0, 3)).toEqual([
			`已触发运行 ${runId}，链接：${cp.httpUrl}/runs/${runId}`,
			...WARNING_LINES,
		]);
	});

	it("没有警告时输出和以前一字不差：给子流程的参数传了值", async () => {
		const { id, name } = await scenario({ host: "h1" });

		const result = await cli("run", "start", name);
		expect(result.code, result.stderr).toBe(0);
		const [runId] = await runsOf(id);
		expect(result.stdout).toBe(
			[
				`已触发运行 ${runId}`,
				`链接：${cp.httpUrl}/runs/${runId}`,
				`等它结束：sfly run wait ${runId}`,
				"",
			].join("\n"),
		);
		expect(result.stderr).toBe("");
	});

	describe("阻断触发的两类问题：命令行读到的是同一份检查", () => {
		it("开发版本没有加载：预检的问题，退出码 2，写明节点、Agent 和 sfly dev，不产生运行", async () => {
			const name = `开发版本场景-${++scenes}`;
			const id = await api.orchestrationWith(
				{
					default_agent: "agent-a",
					nodes: [
						{ id: "entry", kind: "entry", params: [] },
						{ id: "d", kind: "package", package: "demo-dev", node: "ping", inputs: {} },
					],
					edges: [{ from: "entry", to: "d", kind: "chain" }],
					packages: { "demo-dev": "dev" },
				},
				name,
			);

			const result = await cli("run", "start", name);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`错误：场景「${name}」现在不能触发，有 1 个问题：`);
			expect(result.stderr).toContain(
				"  - dev_package_not_loaded：节点 d 用的是开发版本 demo-dev@dev，但它派发到的 Agent agent-a 没有加载：在 agent-a 所在的机器上、节点包源码目录下运行 sfly dev 加载它",
			);
			expect(result.stderr).toContain(`下一步：sfly scenario show ${id}`);
			expect(await runsOf(id)).toEqual([]);
		});

		it("小数接到整数输入：标题说的是值和节点输入的类型不符，并写明参数和节点输入；8.0 是整数，照常触发", async () => {
			const name = `整数输入场景-${++scenes}`;
			const id = await api.orchestrationWith(
				{
					default_agent: "agent-a",
					nodes: [
						{
							id: "entry",
							kind: "entry",
							params: [param("n", { type: "number", required: true })],
						},
						{
							id: "t",
							kind: "package",
							package: "tuner",
							node: "tune",
							inputs: { n: "${{ params.n }}" },
						},
					],
					edges: [{ from: "entry", to: "t", kind: "chain" }],
					packages: { tuner: "1.0.0" },
				},
				name,
			);

			const bad = await cli("run", "start", name, "--param", "n=8.5");
			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain(
				"错误：入口参数的值和它接到的节点输入的类型不符：节点 t 的输入 n 应为 integer，实际是 8.5（入口参数 n，触发时给的值）：请把 n 改成 integer 类型的值再触发，例如：sfly run start <场景> --param n=<整数>",
			);
			// 参数本身没问题（n 是声明过的参数、值是数字），不再把声明的参数列一遍。
			expect(bad.stderr).not.toContain("入口参数不对");
			expect(bad.stderr).not.toMatch(/参数\s+类型\s+说明/);
			expect(bad.stderr).toContain(`下一步：sfly scenario show ${id}`);
			expect(await runsOf(id)).toEqual([]);

			const whole = await cli("run", "start", name, "--param", "n=8.0");
			expect(whole.code, whole.stderr).toBe(0);
			expect(await runsOf(id)).toHaveLength(1);
		});

		it("secret 参数的值合计太大（#632）：说明按「原因、占得最多的、怎么办」分行原样给出，不再列参数的声明，不回显值，不触发运行；--json 的错误对象带 details；下一步是换一个更短的值触发；值小一点就照常触发", async () => {
			const name = `大 secret 值场景-${++scenes}`;
			const id = await api.orchestrationWith(
				{
					default_agent: "agent-a",
					nodes: [
						{
							id: "entry",
							kind: "entry",
							params: [param("token", { secret: true, required: true })],
						},
						echo("t"),
					],
					edges: [{ from: "entry", to: "t", kind: "chain" }],
					packages: { stub: "1.0.0" },
				},
				name,
			);

			await withSecretLimits({ automatonChars: 30_000 }, async () => {
				const big = "QWXZJKVq#%&7".repeat(3_334);
				const bad = await cli("run", "start", name, "--param", `token=${big}`);
				expect(bad.code).toBe(2);
				const [reason, largest, advice] = bad.stderr
					.split("\n")
					.filter((line) => /^(错误：|占得最多的|怎么办)/.test(line));
				expect(reason).toContain(
					"错误：这次触发的 secret 参数的值太多或太长：所有写法合计约 41000 个字符",
				);
				expect(reason).toContain("超过上限 30000 个字符");
				expect(largest).toBe("占得最多的是 参数 token（约 41000 个字符）。");
				expect(advice).toContain("怎么办：缩短这些值");
				// 问题不在参数的声明：不报「入口参数不对」、不列声明的参数，也不回显值
				expect(bad.stderr).not.toContain("入口参数不对");
				expect(bad.stderr).not.toMatch(/参数\s+类型\s+说明/);
				expect(bad.stderr).not.toContain(big.slice(0, 40));
				expect(bad.stderr).toContain(`下一步：sfly run start ${id} --param <名称>=<更短的值>`);
				expect(await runsOf(id)).toEqual([]);

				// --json：错误对象带 details，程序读得到 code
				const json = await cli("run", "start", name, "--param", `token=${big}`, "--json");
				expect(json.code).toBe(2);
				const error = JSON.parse(json.stderr).error;
				expect(error.code).toBe("invalid_params");
				expect(error.details.map((d: { code: string }) => d.code)).toEqual([
					"secret_params_too_large",
				]);
				expect(JSON.stringify(error)).not.toContain(big.slice(0, 40));

				const ok = await cli("run", "start", name, "--param", "token=QWXZ#7");
				expect(ok.code, ok.stderr).toBe(0);
				expect(await runsOf(id)).toHaveLength(1);
			});
		});

		it("触发时改不了的值（子流程的常量）超限：预检的阻断项，命令行列出问题（说明缩进对齐），退出码 2，--json 带 details，下一步是下载场景", async () => {
			const name = `写死的大值场景-${++scenes}`;
			const id = await api.orchestrationWith(
				orchestration(
					[
						[
							{ id: "entry", kind: "entry", params: [] },
							spawn("spawn", { report: "QWXZ#7".repeat(7_000) }),
						],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "汇报",
								params: [param("report", { secret: true })],
							},
							echo("clean"),
						],
					],
					[["spawn", "sub"]],
				),
				name,
			);

			await withSecretLimits({ automatonChars: 30_000 }, async () => {
				const bad = await cli("run", "start", name);
				expect(bad.code).toBe(2);
				expect(bad.stderr).toContain(`场景「${name}」现在不能触发，有 1 个问题：`);
				expect(bad.stderr).toContain("  - secret_params_too_large：场景里写死的 secret 值");
				expect(bad.stderr).toContain(
					"    占得最多的是 子流程 汇报（sub） 的参数 report（约 42000 个字符）。",
				);
				expect(bad.stderr).toContain("    怎么办：改场景：");
				expect(bad.stderr).toContain(`下一步：sfly scenario pull ${id}`);
				expect(await runsOf(id)).toEqual([]);

				const json = await cli("run", "start", name, "--json");
				expect(json.code).toBe(2);
				const error = JSON.parse(json.stderr).error;
				expect(error.code).toBe("invalid_orchestration");
				expect(error.details.map((d: { code: string }) => d.code)).toEqual([
					"secret_params_too_large",
				]);
			});
		});
	});
});
