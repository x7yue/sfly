// sfly run start / wait / cancel：真实的 sfly 进程触发、等待、取消测试控制面里的运行，
// 运行的成功、失败、取消由假 Agent 产生。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { type SflyProcess, spawnSfly } from "./support/sfly-process.js";
import { startTcpProxy } from "./support/tcp-proxy.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const UNKNOWN_RUN = "00000000-0000-4000-8000-000000000000";

type Node = Record<string, unknown> & { id: string };

const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	...extra,
});

const ENTRY_PARAMS = [
	{ name: "host", type: "string", required: true },
	{ name: "retries", type: "number", default: 3 },
	{ name: "verbose", type: "boolean" },
	{ name: "options", type: "json" },
	{ name: "token", type: "string", secret: true },
	{ name: "pin", type: "number", secret: true },
];

describe("sfly run start / wait / cancel → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = new ManualClock();
	const proxies: Array<{ close(): Promise<void> }> = [];
	const processes: SflyProcess[] = [];
	let agents = 0;

	/** 链式的场景：入口节点加按顺序连成一条链的节点，派发到当前测试的 Agent。 */
	const scenario = async (
		name: string,
		nodes: Node[],
		params: unknown[] = [],
		defaultAgent = agent.name,
	): Promise<string> => {
		const all = [{ id: "entry", kind: "entry", params }, ...nodes];
		return api.orchestrationWith(
			{
				default_agent: defaultAgent,
				nodes: all,
				edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
				packages: { stub: "1.0.0" },
			},
			name,
		);
	};
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const start = (...args: string[]): SflyProcess => {
		const process = spawnSfly([...args, "--server", cp.httpUrl]);
		processes.push(process);
		return process;
	};
	const runsOf = async (scenarioId: string) =>
		(
			await api.getJson<{ runs: Array<{ id: string; status: string }> }>(
				`/orchestrations/${scenarioId}/runs`,
			)
		).runs;
	/** 用命令行触发（不等待），返回运行 id。 */
	const trigger = async (name: string): Promise<string> => {
		const result = await cli("run", "start", name, "--json");
		expect(result.code, result.stderr).toBe(0);
		return (JSON.parse(result.stdout) as { id: string }).id;
	};
	/** 等场景出现第 n 个运行，返回它的 id（取最早的）。 */
	const runOf = async (scenarioId: string, count = 1): Promise<string> => {
		let id = "";
		await eventually(async () => {
			const runs = await runsOf(scenarioId);
			expect(runs).toHaveLength(count);
			id = runs.at(-1)?.id ?? "";
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
		await Promise.all(proxies.splice(0).map((p) => p.close()));
		await agent.disconnect();
	});

	afterAll(async () => {
		await cp?.close();
	});

	describe("--wait 和 run wait：等运行结束", () => {
		it("成功：退出码 0，stdout 是摘要，节点状态的进度写在 stderr", async () => {
			const id = await scenario("成功场景", [echo("a"), echo("b")]);
			const waiting = start("run", "start", "成功场景", "--wait", "--nickname", "alice");

			const a = await agent.nextAssign();
			clock.advance(2_000);
			await agent.succeed(a);
			const b = await agent.nextAssign();
			clock.advance(12_000);
			await agent.succeed(b);

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(0);
			const runId = await runOf(id);
			expect(result.stdout).toBe(
				[`运行 ${runId}：成功`, "耗时：14s", `链接：${cp.httpUrl}/runs/${runId}`, ""].join("\n"),
			);
			expect(result.stderr).toContain(`已触发运行 ${runId}`);
			expect(result.stderr.split("\n")).toEqual(
				expect.arrayContaining(["main:a 成功 2.0s", "main:b 成功 12s"]),
			);
			expect(result.stderr).not.toContain("main:entry");
			expect(await api.run(runId)).toMatchObject({ status: "success", triggered_by: "alice" });
		});

		it("失败：退出码 1，摘要里有失败节点的类型、尝试次数、错误和任务最后 50 行日志", async () => {
			const id = await scenario("失败场景", [echo("a"), echo("b", { retries: 1 }), echo("c")]);
			const waiting = start("run", "start", "失败场景", "--wait");

			await agent.succeed(await agent.nextAssign());
			await agent.fail(await agent.nextAssign(), "第一次失败");
			const second = await agent.nextAssign();
			expect(second).toMatchObject({ nodeId: "b", attempt: 2 });
			agent.logs(
				second,
				Array.from({ length: 60 }, (_, i): [number, string] => [i + 1, `日志第 ${i + 1} 行`]),
			);
			await agent.sync();
			clock.advance(3_000);
			await agent.fail(second, "boom: 配置不对\n\nTraceback: x.py line 3");

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(1);
			const runId = await runOf(id);
			const lines = result.stdout.split("\n");
			expect(lines.slice(0, 4)).toEqual([
				`运行 ${runId}：失败`,
				"耗时：3.0s",
				`链接：${cp.httpUrl}/runs/${runId}`,
				"",
			]);
			expect(result.stdout).toContain("失败的节点（1 个）：");
			expect(result.stdout).toContain("  main:b（stub/echo，第 2 次尝试）");
			expect(result.stdout).toContain("    错误：node_error：boom: 配置不对");
			expect(result.stdout).toContain(
				"    错误：node_error：boom: 配置不对\n\n      Traceback: x.py line 3",
			);
			expect(result.stdout).toContain("    最后 50 行日志：");
			expect(result.stdout).toContain("日志第 11 行");
			expect(result.stdout).toContain("日志第 60 行");
			expect(result.stdout).not.toContain("日志第 10 行");
			expect(result.stdout).toContain(`sfly run logs ${runId} --node main:b`);
			expect(result.stdout).not.toContain("main:a");
			expect(result.stderr.split("\n")).toEqual(
				expect.arrayContaining(["main:a 成功 0.0s", "main:b#2 失败 3.0s"]),
			);

			// 已经结束的运行上 run wait 直接输出摘要；--json 时是一个对象，字段相同。
			const json = await cli("run", "wait", runId, "--json");
			expect(json.code, json.stderr).toBe(1);
			const summary = JSON.parse(json.stdout) as Record<string, unknown> & {
				failed: Array<Record<string, unknown> & { logs: unknown[] }>;
			};
			expect(summary).toMatchObject({
				id: runId,
				status: "failed",
				scenario_id: id,
				scenario_version: 1,
				duration_seconds: 3,
				url: `${cp.httpUrl}/runs/${runId}`,
				cancelled_by: null,
			});
			expect(summary.failed).toHaveLength(1);
			expect(summary.failed[0]).toMatchObject({
				chain: "main",
				node: "b",
				type: "stub/echo",
				attempt: 2,
				attempts: 2,
				task: second.taskId,
				error: { kind: "node_error", message: "boom: 配置不对\n\nTraceback: x.py line 3" },
			});
			expect(summary.failed[0]?.logs).toHaveLength(50);
			expect(summary.failed[0]?.logs[0]).toMatchObject({ level: "info", text: "日志第 11 行" });
		});

		it("子流程里的节点失败：摘要和进度里的链写子流程的名称", async () => {
			const nodes = [
				{ id: "entry", kind: "entry", params: [] },
				echo("a"),
				{ id: "spawn", kind: "async", params: {} },
				{ id: "sub", kind: "subflow_entry", name: "report", params: [] },
				echo("send"),
			];
			const id = await api.orchestrationWith(
				{
					default_agent: agent.name,
					nodes,
					edges: [
						{ from: "entry", to: "a", kind: "chain" },
						{ from: "a", to: "spawn", kind: "chain" },
						{ from: "spawn", to: "sub", kind: "dispatch" },
						{ from: "sub", to: "send", kind: "chain" },
					],
					packages: { stub: "1.0.0" },
				},
				"子流程场景",
			);
			const waiting = start("run", "start", "子流程场景", "--wait");
			await agent.succeed(await agent.nextAssign());
			const send = await agent.nextAssign();
			expect(send.nodeId).toBe("send");
			await agent.fail(send, "子流程里失败");

			const result = await waiting.exited;
			const runId = await runOf(id);
			expect((await api.run(runId)).status).toBe("failed");
			expect(result.code, result.stderr).toBe(1);
			expect(result.stdout).toContain("  report:send（stub/echo，第 1 次尝试）");
			expect(result.stdout).toContain("错误：node_error：子流程里失败");
			expect(result.stderr).toContain("report:send 失败");
			expect(result.stderr).toContain("main:a 成功");
		});

		it("取消：退出码 3，摘要写明是谁取消的；运行结束后再取消报 run_not_running", async () => {
			const id = await scenario("取消场景", [echo("a")]);
			const waiting = start("run", "start", "取消场景", "--wait");
			const task = await agent.nextAssign();
			const runId = await runOf(id);

			const cancel = await cli("run", "cancel", runId, "--nickname", "carol");
			expect(cancel.code, cancel.stderr).toBe(0);
			expect(cancel.stdout).toContain(`已请求取消运行 ${runId}`);
			expect(cancel.stdout).toContain(`sfly run wait ${runId}`);
			await agent.nextCancel();
			await agent.cancelled(task);

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(3);
			expect(result.stdout).toContain(`运行 ${runId}：已取消`);
			expect(result.stdout).toMatch(/^由 carol 取消（\S+）$/m);
			expect(result.stderr).toContain("main:a 已取消");

			const again = await cli("run", "cancel", runId, "--json");
			expect(again.code).toBe(2);
			expect(JSON.parse(again.stderr)).toEqual({
				error: {
					code: "run_not_running",
					message: "run is already cancelled",
					next: `sfly run show ${runId}`,
				},
			});
			const text = await cli("run", "cancel", runId);
			expect(text.code).toBe(2);
			expect(text.stderr).toContain("错误：run is already cancelled");
			expect(text.stderr).toContain(`下一步：sfly run show ${runId}`);
		});

		it("等待超时：退出码 124，运行仍在继续，之后用 run wait 等到它结束", async () => {
			const id = await scenario("超时场景", [echo("a")]);
			const timedOut = start("run", "start", "超时场景", "--wait", "--timeout", "1");
			const task = await agent.nextAssign();
			const runId = await runOf(id);

			const result = await timedOut.exited;
			expect(result.code, result.stderr).toBe(124);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("等待超时（1.0s），运行");
			expect(result.stderr).toContain("没有被取消");
			expect(result.stderr).toContain(`取消运行：sfly run cancel ${runId}`);
			expect(result.stderr).toContain(`下一步：sfly run wait ${runId}`);
			expect((await api.run(runId)).status).toBe("running");

			const resumed = start("run", "wait", runId);
			await resumed.waitForStderr("main:a 运行中");
			clock.advance(5_000);
			await agent.succeed(task);
			const finished = await resumed.exited;
			expect(finished.code, finished.stderr).toBe(0);
			expect(finished.stdout).toContain(`运行 ${runId}：成功`);
			expect(finished.stdout).toContain("耗时：5.0s");
			expect(await api.run(runId)).toMatchObject({ status: "success", cancel: null });
		});

		it("按 Ctrl-C 停止等待：退出码 130，运行仍在继续，提示怎么接着等、怎么取消", async () => {
			const id = await scenario("中断场景", [echo("a")]);
			const waiting = start("run", "start", "中断场景", "--wait");
			const task = await agent.nextAssign();
			await waiting.waitForStderr("已触发运行");
			const runId = await runOf(id);

			waiting.interrupt();
			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(130);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`运行 ${runId} 仍在继续，没有被取消`);
			expect(result.stderr).toContain(`取消运行：sfly run cancel ${runId}`);
			expect(result.stderr).toContain(`下一步：sfly run wait ${runId}`);
			expect(result.stderr).not.toContain("Traceback");
			expect((await api.run(runId)).status).toBe("running");

			const resumed = cli("run", "wait", runId);
			await agent.succeed(task);
			expect((await resumed).code).toBe(0);
		});

		it("等待期间连接断开后自动重连：断线时运行已经结束，结束状态不丢", async () => {
			const proxy = await startTcpProxy(cp.httpUrl);
			proxies.push(proxy);
			const id = await scenario("断线场景", [echo("a")]);
			const runId = await trigger("断线场景");
			const task = await agent.nextAssign();

			const waiting = spawnSfly(["run", "wait", runId, "--server", proxy.url]);
			processes.push(waiting);
			await eventually(() => expect(proxy.streamsOpened).toBe(1), 20_000);
			proxy.block();
			proxy.dropConnections();
			clock.advance(4_000);
			await agent.succeed(task);
			expect((await api.run(runId)).status).toBe("success");
			proxy.unblock();

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`运行 ${runId}：成功`);
			expect(result.stderr).toContain("与控制面的连接断开");
			expect(result.stderr).toContain("已重新连接");
			expect(await runsOf(id)).toHaveLength(1);
		});

		it("断线重连之后继续接收后面的变化", async () => {
			const proxy = await startTcpProxy(cp.httpUrl);
			proxies.push(proxy);
			await scenario("重连场景", [echo("a"), echo("b")]);
			const runId = await trigger("重连场景");
			const first = await agent.nextAssign();

			const waiting = spawnSfly(["run", "wait", runId, "--server", proxy.url]);
			processes.push(waiting);
			await eventually(() => expect(proxy.streamsOpened).toBe(1), 20_000);
			proxy.dropConnections();
			await eventually(() => expect(proxy.streamsOpened).toBe(2), 20_000);
			await agent.succeed(first);
			const second = await agent.nextAssign();
			await agent.fail(second, "断线之后失败");

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(1);
			expect(result.stdout).toContain(`运行 ${runId}：失败`);
			expect(result.stdout).toContain("断线之后失败");
			expect(result.stderr).toContain("已重新连接");
			expect(result.stderr.split("\n")).toContain("main:a 成功 0.0s");
		});

		it("运行不存在时报错并提示 run list", async () => {
			const wait = await cli("run", "wait", UNKNOWN_RUN);
			expect(wait.code).toBe(2);
			expect(wait.stderr).toContain("错误：run not found");
			expect(wait.stderr).toContain("下一步：sfly run list");
			const cancel = await cli("run", "cancel", UNKNOWN_RUN);
			expect(cancel.code).toBe(2);
			expect(cancel.stderr).toContain("下一步：sfly run list");
		});
	});

	describe("run start：预检", () => {
		it("预检有问题时列出问题、退出码 2、不产生运行", async () => {
			const ghost = await scenario("预检场景", [echo("a")], [], "agent-ghost");
			const result = await cli("run", "start", "预检场景");
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("错误：场景「预检场景」现在不能触发，有 1 个问题：");
			expect(result.stderr).toContain("  - agent_not_registered：");
			expect(result.stderr).toContain("agent-ghost");
			expect(result.stderr).toContain(`下一步：sfly scenario show ${ghost}`);
			expect(await runsOf(ghost)).toEqual([]);

			const json = await cli("run", "start", "预检场景", "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error).toMatchObject({
				code: "invalid_orchestration",
				next: `sfly scenario show ${ghost}`,
			});
			expect(await runsOf(ghost)).toEqual([]);

			const empty = await api.createOrchestration("没有版本的场景");
			const noVersion = await cli("run", "start", "没有版本的场景");
			expect(noVersion.code).toBe(2);
			expect(noVersion.stderr).toContain("no_version：场景还没有保存过版本");
			expect(await runsOf(empty)).toEqual([]);
		});

		it("场景不存在或名称对应多个场景时报错", async () => {
			const missing = await cli("run", "start", "没有这个场景");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有 id 或名称是「没有这个场景」的场景");
			await scenario("重名场景", [echo("a")]);
			await scenario("重名场景", [echo("a")]);
			const twin = await cli("run", "start", "重名场景");
			expect(twin.code).toBe(2);
			expect(twin.stderr).toContain("对应 2 个场景");
		});

		it("--timeout 需要和 --wait 一起用", async () => {
			const id = await scenario("超时参数场景", [echo("a")]);
			const result = await cli("run", "start", "超时参数场景", "--timeout", "5");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--timeout 限制的是等待的时长，需要和 --wait 一起用");
			const invalid = await cli("run", "start", "超时参数场景", "--wait", "--timeout", "很久");
			expect(invalid.code).toBe(2);
			expect(invalid.stderr).toContain("需要大于 0 的时长");
			expect(await runsOf(id)).toEqual([]);
		});
	});

	describe("run start：参数", () => {
		let scenarioId: string;

		beforeEach(async () => {
			scenarioId = await scenario(`参数场景-${agents}`, [echo("a")], ENTRY_PARAMS);
		});

		const startParams = (...args: string[]) => cli("run", "start", scenarioId, ...args);
		const lastRun = async () => api.run(await runOf(scenarioId));

		it("不加 --wait：输出运行 id 和控制台里的运行链接，值按声明的类型转换，secret 不回显", async () => {
			const result = await startParams(
				...["--param", "host=h1"],
				...["--param", "retries=2.5"],
				...["--param", "verbose=TRUE"],
				...["--param", 'options={"a":[1,2],"b":null}'],
				...["--param", "token=s3cretvalue"],
				...["--param", "pin=1234"],
			);
			expect(result.code, result.stderr).toBe(0);
			const run = await lastRun();
			expect(result.stdout).toBe(
				[
					`已触发运行 ${run.id}`,
					`链接：${cp.httpUrl}/runs/${run.id}`,
					`等它结束：sfly run wait ${run.id}`,
					"",
				].join("\n"),
			);
			expect(result.stderr).toBe("");
			expect(`${result.stdout}${result.stderr}`).not.toContain("s3cretvalue");
			expect(run.params).toMatchObject({
				host: "h1",
				retries: 2.5,
				verbose: true,
				options: { a: [1, 2], b: null },
			});
			expect(run.params.token).not.toBe("s3cretvalue");
			expect(run.params.pin).not.toBe(1234);
			expect(run.status).toBe("running");
			expect(run.orchestration_version).toBe(1);
		});

		it("--json 输出一个对象；string 参数原样保留，默认值照常生效", async () => {
			const result = await startParams("--param", "host=007", "--param", "options=[1]", "--json");
			expect(result.code, result.stderr).toBe(0);
			const run = await lastRun();
			expect(JSON.parse(result.stdout)).toEqual({
				id: run.id,
				status: "running",
				scenario_id: scenarioId,
				scenario_version: 1,
				url: `${cp.httpUrl}/runs/${run.id}`,
			});
			expect(result.stderr).toBe(`等它结束：sfly run wait ${run.id}\n`);
			expect(run.params).toMatchObject({ host: "007", retries: 3, options: [1] });
		});

		it("--param 覆盖 --params 里的同名项；值里可以有 =", async () => {
			const result = await startParams(
				...["--params", '{"host":"from-json","retries":1,"options":{"k":"v"}}'],
				...["--param", "retries=9"],
				...["--param", "host=a=b"],
			);
			expect(result.code, result.stderr).toBe(0);
			expect((await lastRun()).params).toMatchObject({
				host: "a=b",
				retries: 9,
				options: { k: "v" },
			});
		});

		it.each([
			["参数名没有声明", ["--param", "nope=1"], ["参数 nope 没有声明"]],
			["--params 里的参数名没有声明", ["--params", '{"nope":1}'], ["参数 nope 没有声明"]],
			[
				"number 转换失败",
				["--param", "retries=abc"],
				["参数 retries 的值 'abc' 不是合法的 number"],
			],
			["number 不接受 NaN", ["--param", "retries=NaN"], ["参数 retries 的值 'NaN'"]],
			["boolean 只接受 true 和 false", ["--param", "verbose=yes"], ["参数 verbose 的值 'yes'"]],
			["json 转换失败", ["--param", "options={bad"], ["参数 options 的值 '{bad'"]],
			["缺少 =", ["--param", "host"], ["--param 的格式是 名=值"]],
			["--params 不是 JSON", ["--params", "{bad"], ["--params 不是合法的 JSON"]],
			["--params 不是对象", ["--params", "[1]"], ["--params 需要一个 JSON 对象"]],
			["缺少必填参数", ["--param", "retries=1"], ["入口参数不对：", "host"]],
			["--params 里的类型不对", ["--params", '{"host":5}'], ["入口参数不对：", "host"]],
		])("%s：报错并列出声明的参数，退出码 2，不产生运行", async (_name, args, expected) => {
			const result = await startParams(...args);
			expect(result.code, result.stdout).toBe(2);
			expect(result.stdout).toBe("");
			for (const text of expected) expect(result.stderr).toContain(text);
			expect(result.stderr).toContain("声明的参数：");
			expect(result.stderr).toContain("host     string   必填");
			expect(result.stderr).toContain("retries  number   默认 3");
			expect(result.stderr).toContain("token    string   secret");
			expect(result.stderr).toContain(`下一步：sfly scenario show ${scenarioId}`);
			expect(await runsOf(scenarioId)).toEqual([]);
		});

		it("secret 参数转换失败时，错误里不出现它的值", async () => {
			const result = await startParams("--param", "host=h1", "--param", "pin=oops-secret");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("参数 pin 的值不是合法的 number");
			expect(result.stderr).not.toContain("oops-secret");
			expect(await runsOf(scenarioId)).toEqual([]);
		});

		it("入口节点没有声明参数时，给了参数就报错", async () => {
			const bare = await scenario(`无参数场景-${agents}`, [echo("a")]);
			const result = await cli("run", "start", bare, "--param", "x=1");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("参数 x 没有声明");
			expect(result.stderr).toContain("场景的入口节点没有声明参数");
			expect(await runsOf(bare)).toEqual([]);
		});
	});

	describe("记录昵称和经哪个 AI 编程助手", () => {
		it("经命令行触发、取消的运行上，记录了昵称、x-sfly-client 和检测到的 AI 编程助手", async () => {
			const proxy: RecordingProxy = await startRecordingProxy(cp.httpUrl);
			proxies.push(proxy);
			const id = await scenario("记录场景", [echo("a")]);
			const env = { CLAUDECODE: "1" };
			const triggered = await sfly(
				["run", "start", "记录场景", "--server", proxy.url, "--nickname", "dana"],
				{ env },
			);
			expect(triggered.code, triggered.stderr).toBe(0);
			const task = await agent.nextAssign();
			const runId = await runOf(id);
			const cancelled = await sfly(
				["run", "cancel", runId, "--server", proxy.url, "--nickname", "dana"],
				{ env },
			);
			expect(cancelled.code, cancelled.stderr).toBe(0);
			await agent.nextCancel();
			await agent.cancelled(task);

			const writes = proxy.requests.filter((r) => r.method === "POST");
			expect(writes.map((r) => r.path)).toEqual([
				`/orchestrations/${id}/runs`,
				`/runs/${runId}/cancel`,
			]);
			for (const write of writes) {
				expect(write.headers["x-sfly-client"]).toMatch(/^sfly-cli\/\S+ agent\/claude-code$/);
				expect(write.headers["x-sfly-nickname"]).toBe("dana");
			}
			const run = await api.run(runId);
			expect(run).toMatchObject({
				status: "cancelled",
				triggered_by: "dana",
				triggered_via: "claude-code",
				cancel: { requested_by: "dana", requested_via: "claude-code" },
			});
		});

		it("不在 AI 编程助手里时，运行上没有「经 …」", async () => {
			const id = await scenario("人工场景", [echo("a")]);
			const result = await cli("run", "start", "人工场景", "--nickname", "erin");
			expect(result.code, result.stderr).toBe(0);
			expect(await api.run(await runOf(id))).toMatchObject({
				triggered_by: "erin",
				triggered_via: null,
			});
		});
	});
});
