// 数据库连接出错时控制面怎么办（#563，docs/ARCHITECTURE.md §6.10）。用真实的控制面**进程**（`node --import tsx src/main.ts`，
// 生产环境变量）：进程退不退出在测试进程里看不出来，只有起一个进程才能断言。数据库前面放一个 TCP 转发（`PgProxy`），
// 在客户端**发出**某条语句的那一刻断开这一条连接：每次都是同一个位置（`BEGIN` 上、事务中间、COMMIT 之前、COMMIT 之后）。
//
// 规矩：
// - **借出去的连接（事务里）出错**：以前是没人接的 `error` 事件，进程当场退出，重启之后靠已有的恢复（引擎启动时的恢复、Agent 重连后
//   重发结果）自己好。现在仍然退出，但是有序地、带着一句看得懂的日志（退出码 1），由重启恢复；断开那一刻连接池就结束了，
//   这次操作的失败处理什么都写不进去（不会把 Agent 报来的成功记成节点出错）。
// - **空闲的连接**、**`pool.query` 的单条语句**出错：进程不退出（以前也不退出）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slowDown, sql, terminateActive, terminateIdle } from "./support/db-sabotage.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { PgProxy } from "./support/pg-proxy.js";
import { type SourceServer, StartupExitError, startSourceServer } from "./support/source-server.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 起一个真实的控制面进程（生产环境变量、初始管理员 root 已登录）：`dataDir` 给了就用它（同一个数据目录和库重新起一个，模拟重启策略把退出的控制面拉起来）。 */
const startProcess = (
	databaseUrl: string,
	env: Record<string, string> = {},
	options: { dataDir?: string; ports?: { http: number; grpc: number } } = {},
) => startSourceServer({ databaseUrl, env, admin: true, production: true, ...options });

const ENTRY_ONLY = { nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} };
const node = (id: string) => ({ id, kind: "package", package: "stub", node: "echo", inputs: {} });
const TWO_NODES = {
	default_agent: "agent-a",
	nodes: [{ id: "entry", kind: "entry", params: [] }, node("a"), node("b")],
	edges: [
		{ from: "entry", to: "a", kind: "chain" },
		{ from: "a", to: "b", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};
/** 出现在任务结果里：写结果的那条语句的参数。日志里不能有它。 */
const PARAM_MARK = "SECRET-OUTPUT-MARK-7c2f";

/** 各个位置的语句。 */
const INSERT_VERSION = /^insert into "orchestration_versions"/;
const RESULT_UPDATE = /^update "tasks" set .*"outputs" = /s;
const DISPATCH_UPDATE = /^update "tasks" set .*"referenced_feishu_bots" = /s;

describe("借出去的连接（事务里）出错：有序退出，由重启恢复", () => {
	let database: TestDatabase;
	let proxy: PgProxy;
	let cp: SourceServer;
	let restarted: SourceServer | undefined;
	let agents: FakeAgent[];

	beforeEach(async () => {
		database = await createTestDatabase("sfly_dbconn");
		proxy = await PgProxy.start(database.url);
		cp = await startProcess(proxy.urlFor(database.url));
		agents = [];
	}, 90_000);
	afterEach(async () => {
		await Promise.all(agents.map((a) => a.disconnect().catch(() => undefined)));
		await restarted?.kill();
		restarted = undefined;
		await cp.kill();
		await proxy.close();
		await database.drop();
	});

	const connectAgent = async (
		target: SourceServer,
		held: { taskId: string; attempt: number }[] = [],
	) => {
		const agent = await FakeAgent.connect(target.grpcUrl, {
			name: "agent-a",
			runningTasks: held.map((t) => ({ taskId: t.taskId, attempt: t.attempt, started: true })),
		});
		agents.push(agent);
		return agent;
	};
	const createScenario = async (name: string, document: unknown) => {
		const created = (await (await cp.request("POST", "/orchestrations", { name })).json()) as {
			id: string;
		};
		const saved = await cp.request("POST", `/orchestrations/${created.id}/versions`, {
			base_version: 0,
			document,
		});
		expect(saved.status).toBe(201);
		return created.id;
	};
	const trigger = async (target: SourceServer, scenarioId: string) =>
		target.request("POST", `/orchestrations/${scenarioId}/runs`, { params: {} });
	const runStatus = async (target: SourceServer, runId: string) =>
		((await (await target.request("GET", `/runs/${runId}`)).json()) as { status: string }).status;

	/** 进程有序退出：退出码 1、在时限内，日志里有那句明确的话，没有数据库地址和语句的参数。 */
	const expectOrderlyExit = async () => {
		const exit = await cp.waitForExit(8_000);
		expect(exit, `控制面没有在 8 秒内退出：\n${cp.log.slice(-2000)}`).toEqual({
			code: 1,
			signal: null,
		});
		expect(cp.log).toContain("数据库连接在使用中断开");
		expect(cp.log).toContain("有序关闭后以退出码 1 退出");
		expect(cp.log).not.toContain(database.url);
		expect(cp.log).not.toContain(PARAM_MARK);
	};
	/** 同一个库（不经转发）和同一个数据目录重新起一个：部署的重启策略做的事。 */
	const restart = async () => {
		restarted = await startProcess(database.url, {}, { dataDir: cp.dataDir });
		expect((await restarted.request("GET", "/health")).status).toBe(200);
		return restarted;
	};

	describe("HTTP 请求里的事务（保存场景版本）", () => {
		it.each([
			["事务中间（写版本的那条语句上）", INSERT_VERSION, "drop", "没有存下"],
			["COMMIT 之前", INSERT_VERSION, "commit-before", "没有存下"],
			[
				"COMMIT 之后（数据库已经提交，客户端只看到连接断了）",
				INSERT_VERSION,
				"commit-after",
				"已经存下",
			],
		] as const)(
			"%s 断开：进程有序退出，重启之后库里的版本和请求的结局一致",
			async (_, match, action, stored) => {
				const created = (await (
					await cp.request("POST", "/orchestrations", { name: "连接被断开" })
				).json()) as { id: string };
				proxy.arm(match, action);

				const response = await cp
					.request("POST", `/orchestrations/${created.id}/versions`, {
						base_version: 0,
						document: ENTRY_ONLY,
					})
					.then((r) => r.status)
					.catch(() => "没有响应");

				// 这次请求没有成功的响应（5xx，或者进程已经退出、连接断了）。
				expect(response === "没有响应" || (typeof response === "number" && response >= 500)).toBe(
					true,
				);
				// 匹配的语句触发一次；COMMIT 的两种还会再记一条「COMMIT 上触发了」。
				expect(proxy.fired.map((f) => f.stage)).toEqual(
					action === "drop" ? ["match"] : ["match", "commit"],
				);
				await expectOrderlyExit();
				const second = await restart();
				const retried = await second.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				});
				// 「500 不代表没写进去」：COMMIT 之后断开时数据库已经提交，拿同一个 base_version 重试是 409。
				expect(retried.status).toBe(stored === "没有存下" ? 201 : 409);
			},
			120_000,
		);

		it("BEGIN 上断开（drizzle 在 BEGIN 失败时借出去的连接永远不还）：进程有序退出，连接池关不完也在时限内退出，重启之后一切照常", async () => {
			const created = (await (
				await cp.request("POST", "/orchestrations", { name: "BEGIN 上断开" })
			).json()) as { id: string };
			proxy.arm(/^begin/i, "drop");

			await cp
				.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
				.catch(() => undefined);

			expect(proxy.fired).toHaveLength(1);
			await expectOrderlyExit();
			// 借出去没还的连接让 pool.end() 永远不结束：有序关闭没有卡在那里，记了一条说明，用自己的前缀（不是又断了一条连接）。
			expect(cp.log).toContain("没有关完");
			expect(cp.log).toContain("database pool shutdown:");
			expect(cp.log).not.toMatch(/postgres connection error:[^\n]*没有关完/);
			const second = await restart();
			const retried = await second.request("POST", `/orchestrations/${created.id}/versions`, {
				base_version: 0,
				document: ENTRY_ONLY,
			});
			expect(retried.status).toBe(201);
		}, 120_000);
	});

	describe("数据库先发致命错误消息、再关连接（pg_terminate_backend）", () => {
		// 和上面「掐断 TCP」的区别：pg 收到致命错误消息时，连接上有正在执行的语句（这里是被扣住的 BEGIN），只让这条语句以错误结束，
		// 不发 `error`，`error` 要等连接真的关闭才来。HTTP 的事务在这里出错只是请求以 5xx 结束，没有失败处理会写东西，所以这条本身
		// 不区分有没有「一收到致命错误消息就当作完了」；区分的是下面引擎的那条（失败处理会再借连接写）。
		it("HTTP 请求里的事务在 BEGIN 上收到：进程有序退出，没有存下，重启之后一切照常", async () => {
			const created = (await (
				await cp.request("POST", "/orchestrations", { name: "BEGIN 上收到 FATAL" })
			).json()) as { id: string };
			proxy.arm(/^begin/i, "terminate-backend");

			const response = await cp
				.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
				.then((r) => r.status)
				.catch(() => "没有响应");

			expect(response === "没有响应" || (typeof response === "number" && response >= 500)).toBe(
				true,
			);
			expect(proxy.fired.map((f) => f.action)).toEqual(["terminate-backend"]);
			await expectOrderlyExit();
			const second = await restart();
			const retried = await second.request("POST", `/orchestrations/${created.id}/versions`, {
				base_version: 0,
				document: ENTRY_ONLY,
			});
			expect(retried.status).toBe(201);
		}, 120_000);
	});

	// 因错误而有序退出（上面）和停止信号（`src/shutdown.ts`）是两条都会调用 `close()`、都会退出的路径：已经因为错误在退出时，退出码不能被
	// 停止信号那一条变成 0（按失败才重启的部署不会把状态不可信的进程拉起来）；停止信号先到、关闭途中又出致命错误，退出码也是 1。
	describe("有序退出和停止信号一起来：退出码都是 1", () => {
		it("致命错误先到、有序退出途中来了两个停止信号：退出码仍是 1，不是 0", async () => {
			const created = (await (
				await cp.request("POST", "/orchestrations", { name: "致命错误后来停止信号" })
			).json()) as { id: string };
			// BEGIN 上断开：借出去的连接永远不还，有序关闭要等连接池的 3 秒上限，这段时间里停止信号到。
			proxy.arm(/^begin/i, "drop");
			void cp
				.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
				.catch(() => undefined);
			await eventually(async () => expect(cp.log).toContain("数据库连接在使用中断开"), 10_000);

			cp.child.kill("SIGTERM");
			cp.child.kill("SIGTERM");

			const exit = await cp.waitForExit(15_000);
			expect(exit, `控制面没有退出：\n${cp.log.slice(-2000)}`).toEqual({ code: 1, signal: null });
			// 停止信号那条路径确实走了（收到、第二个被忽略）：退出码 1 是因为已经在因错误退出，不是因为它没走。
			expect(cp.log).toContain("收到 SIGTERM，正在关闭");
			expect(cp.log).toContain("已经在关闭，忽略 SIGTERM");
		}, 120_000);

		it("停止信号先到、关闭途中借出去的连接收到致命错误：退出码是 1（关闭没写完的东西没有人补，如实说明这次退出不干净）", async () => {
			const created = (await (
				await cp.request("POST", "/orchestrations", { name: "停止信号后来致命错误" })
			).json()) as { id: string };
			// 保存版本的那条语句在数据库里「进行中」6 秒：有序关闭等进行中的请求，这段时间里结束它的连接。
			await slowDown(database.url, "orchestration_versions", "insert", 6);
			const inFlight = cp
				.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
				.then((r) => r.status)
				.catch(() => "没有响应");
			await new Promise((resolve) => setTimeout(resolve, 1_000));

			cp.child.kill("SIGTERM");
			await eventually(async () => expect(cp.log).toContain("收到 SIGTERM，正在关闭"), 10_000);
			expect(await terminateActive(database.url, "orchestration_versions")).toBeGreaterThanOrEqual(
				1,
			);
			await inFlight;

			const exit = await cp.waitForExit(15_000);
			expect(exit, `控制面没有退出：\n${cp.log.slice(-2000)}`).toEqual({ code: 1, signal: null });
			expect(cp.log).toContain("数据库连接在使用中断开");
		}, 120_000);
	});

	describe("引擎的事务", () => {
		const startRun = async (document: unknown, name: string) => {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const agent = await connectAgent(cp);
			const scenarioId = await createScenario(name, document);
			const res = await trigger(cp, scenarioId);
			expect(res.status).toBe(201);
			const runId = ((await res.json()) as { id: string }).id;
			return { agent, scenarioId, runId };
		};
		const taskRows = () =>
			sql<{ node_id: string; status: string; error_kind: string | null }>(
				database.url,
				"select node_id, status, error_kind from tasks order by seq",
			);
		const finishRemaining = async (target: SourceServer, agent: FakeAgent, runId: string) => {
			for (let i = 0; i < 2; i++) {
				const assigned = await agent.nextAssign({ timeoutMs: 15_000 }).catch(() => undefined);
				if (assigned) await agent.succeed(assigned, { v: i });
			}
			await eventually(async () => expect(await runStatus(target, runId)).toBe("success"), 30_000);
		};

		it("写任务结果的事务中间断开：进程有序退出，这次尝试没有被记成节点出错（库里还是在跑），Agent 重连、重发结果，运行成功", async () => {
			const { agent, runId } = await startRun(TWO_NODES, "结果-事务中间");
			const task = await agent.nextAssign();
			proxy.arm(RESULT_UPDATE, "drop");

			await agent.succeed(task, { v: PARAM_MARK }).catch(() => undefined);

			await expectOrderlyExit();
			// 退出的那一刻连接池就结束了：失败处理（把这次尝试记成节点出错、运行失败）什么都写不进去。
			const rows = await taskRows();
			expect(rows.find((r) => r.node_id === "a")).toMatchObject({ error_kind: null });
			expect(rows.map((r) => r.status)).not.toContain("failed");
			expect(await sql(database.url, "select status from runs")).toEqual([{ status: "running" }]);

			const second = await restart();
			await agent.disconnect();
			const reconnected = await connectAgent(second, [task]);
			expect(reconnected.dispositions[task.taskId]).toBe("continue");
			await reconnected.succeed(task, { v: 1 });
			await finishRemaining(second, reconnected, runId);
		}, 150_000);

		// 数据库先发一条致命错误消息、再关连接，而这条消息落在写结果的事务的 BEGIN 上：事务立刻被拒绝，引擎的失败处理（把这次尝试
		// 记成节点出错）马上要从池里借另一条好的连接写。连接池要是等到连接真的关闭（`error` 事件）才结束，失败处理已经写进去了：
		// Agent 报来的成功被记成节点出错，运行失败，配了重试的还会再执行一遍（#563 的复审）。现在致命错误消息一到连接池就结束了。
		it("写任务结果的事务在 BEGIN 上收到数据库的致命错误消息（pg_terminate_backend）：进程有序退出，没有被记成节点出错（库里还是在跑），Agent 重连、重发，运行成功，每个节点只尝试一次", async () => {
			const { agent, runId } = await startRun(TWO_NODES, "结果-BEGIN-FATAL");
			const task = await agent.nextAssign();
			proxy.arm(/^begin/i, "terminate-backend");

			await agent.succeed(task, { v: PARAM_MARK }).catch(() => undefined);

			await expectOrderlyExit();
			expect(proxy.fired.map((f) => f.action)).toEqual(["terminate-backend"]);
			// 失败处理什么都没写进去：这次尝试还是「在跑」，没有错误，没有失败的状态。
			const rows = await taskRows();
			expect(rows.find((r) => r.node_id === "a")).toMatchObject({
				status: "running",
				error_kind: null,
			});
			expect(rows.map((r) => r.status)).not.toContain("failed");
			expect(await sql(database.url, "select status from runs")).toEqual([{ status: "running" }]);

			const second = await restart();
			await agent.disconnect();
			const reconnected = await connectAgent(second, [task]);
			expect(reconnected.dispositions[task.taskId]).toBe("continue");
			await reconnected.succeed(task, { v: 1 });
			await finishRemaining(second, reconnected, runId);
			// 没有第二次执行：每个节点只有第 1 次尝试。
			expect(
				await sql<{ node_id: string; attempt: number }>(
					database.url,
					"select node_id, attempt from tasks where attempt > 1",
				),
			).toEqual([]);
		}, 150_000);

		it("写任务结果的 COMMIT 之后断开（数据库已经提交，结果的确认丢了）：进程有序退出，重启之后下一个节点照常派发，运行成功", async () => {
			const { agent, runId } = await startRun(TWO_NODES, "结果-提交之后");
			const task = await agent.nextAssign();
			proxy.arm(RESULT_UPDATE, "commit-after");

			await agent.succeed(task, { v: PARAM_MARK }).catch(() => undefined);

			await expectOrderlyExit();
			expect((await taskRows()).find((r) => r.node_id === "a")?.status).toBe("success");

			const second = await restart();
			await agent.disconnect();
			const reconnected = await connectAgent(second);
			await finishRemaining(second, reconnected, runId);
		}, 150_000);

		it("提交之后的派发那一步断开：触发的请求没有成功的响应，进程有序退出；重启、Agent 重连之后排着队的任务派发出去，运行成功", async () => {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const agent = await connectAgent(cp);
			const scenarioId = await createScenario("派发", TWO_NODES);
			proxy.arm(DISPATCH_UPDATE, "drop");

			const response = await trigger(cp, scenarioId)
				.then((r) => r.status)
				.catch(() => "没有响应");

			expect(response === "没有响应" || (typeof response === "number" && response >= 500)).toBe(
				true,
			);
			await expectOrderlyExit();
			// 运行已经建好、任务排着队，没有被记成失败。
			expect((await taskRows()).map((r) => r.status)).toContain("queued");

			const second = await restart();
			await agent.disconnect();
			const reconnected = await connectAgent(second);
			const runs = await sql<{ id: string }>(database.url, "select id from runs");
			expect(runs).toHaveLength(1);
			await finishRemaining(second, reconnected, (runs[0] as { id: string }).id);
		}, 150_000);
	});

	describe("数据库整体不可用", () => {
		it("正好有事务在进行时数据库不可用：进程有序退出；数据库没回来之前重启起不来（启动时就退出，重启策略会一直重试）；数据库回来之后起得来", async () => {
			const created = (await (
				await cp.request("POST", "/orchestrations", { name: "不可用" })
			).json()) as { id: string };
			// 让保存版本的那条语句在数据库里「进行中」几秒，在这段时间里整个数据库不可用。
			await slowDown(database.url, "orchestration_versions", "insert", 8);
			const doomed = cp
				.request("POST", `/orchestrations/${created.id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
				.catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 1_500));

			await proxy.outage();
			await doomed;

			await expectOrderlyExit();
			// 数据库还没回来：新进程连不上、启动时就退出。
			await expect(
				startProcess(proxy.urlFor(database.url), {}, { dataDir: cp.dataDir }),
			).rejects.toBeInstanceOf(StartupExitError);
			await proxy.recover();
			restarted = await startProcess(proxy.urlFor(database.url), {}, { dataDir: cp.dataDir });
			expect((await restarted.request("GET", "/health")).status).toBe(200);
		}, 150_000);
	});
});

describe("没有借出去的连接出错：进程不退出（以前也不退出）", () => {
	let database: TestDatabase;
	let proxy: PgProxy;
	let cp: SourceServer;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_dbconn");
		proxy = await PgProxy.start(database.url);
		cp = await startProcess(proxy.urlFor(database.url));
	}, 90_000);
	afterEach(async () => {
		await cp.kill();
		await proxy.close();
		await database.drop();
	});

	const expectAlive = async () => {
		expect(
			await cp.waitForExit(1_500),
			`控制面进程退出了：\n${cp.log.slice(-1500)}`,
		).toBeUndefined();
		expect((await cp.request("GET", "/health")).status).toBe(200);
	};

	it("单条语句（`pool.query`，不在事务里）的连接断开：这次请求以 5xx 结束，进程不退出，之后的请求照常", async () => {
		proxy.arm(/^insert into "orchestrations"/, "drop");

		const res = await cp.request("POST", "/orchestrations", { name: "单条语句" });

		expect(proxy.fired).toHaveLength(1);
		expect(res.status).toBeGreaterThanOrEqual(500);
		await expectAlive();
		expect((await cp.request("POST", "/orchestrations", { name: "之后" })).status).toBe(201);
	}, 90_000);

	it("空闲的连接被结束：进程不退出，记一条连接错误的日志，之后的请求照常", async () => {
		await cp.request("GET", "/orchestrations");
		await new Promise((resolve) => setTimeout(resolve, 300));

		// 机器忙的时候（CI 上整套测试一起跑）这一刻控制面唯一的连接可能正在执行别的语句、不是空闲的：等到有空闲的再结束
		// （CI 上失败过一次，`terminateIdle` 找到 0 个；本机连跑 8 遍没有复现）。
		await eventually(async () => {
			expect(await terminateIdle(database.url)).toBeGreaterThanOrEqual(1);
		}, 10_000);
		await eventually(async () => expect(cp.log).toContain("postgres connection error"), 10_000);

		await expectAlive();
		expect((await cp.request("POST", "/orchestrations", { name: "空闲之后" })).status).toBe(201);
		// 不是「借出去的连接出错」的退出。
		expect(cp.log).not.toContain("数据库连接在使用中断开");
	}, 90_000);
});
