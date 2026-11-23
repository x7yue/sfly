// 数据库连接出错时控制面不崩溃（#563）。用真实的控制面**进程**（`node --import tsx src/main.ts`，生产环境变量）：
// 进程崩溃在测试进程里看不出来，只有起一个进程才能断言「进程没有退出」。
//
// 事务进行到一半时连接被数据库结束（数据库重启、`pg_terminate_backend`、网络中断），pg 在这个**借出中的**连接上
// 触发 `error` 事件。连接池只在空闲的连接上挂了错误处理，借出的连接上没有：没人接的 `error` 事件是未捕获的异常，
// 进程以退出码 1 退出——所有 Agent 的连接、所有打开的事件流都断，要靠部署的重启策略才能回来。
// 从数据库一侧造出「事务进行到一半」：在表上加一个睡几秒的触发器，控制面写这张表时那条语句在数据库里进行着，
// 测试在这段时间里结束它的连接。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneProcess } from "./support/control-plane-process.js";
import { slowDown, speedUp, terminateActive, terminateIdle } from "./support/db-sabotage.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { PgProxy } from "./support/pg-proxy.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const ENTRY_ONLY = { nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} };
const ECHO = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo", inputs: {} },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("数据库连接在事务进行中被结束", () => {
	let database: TestDatabase;
	let cp: ControlPlaneProcess;
	let agent: FakeAgent | undefined;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_dbconn");
		cp = await ControlPlaneProcess.start(database.url);
	}, 90_000);
	afterEach(async () => {
		await agent?.disconnect();
		agent = undefined;
		await cp.stop();
		await database.drop();
	});

	const runStatus = async (runId: string) =>
		((await (await cp.request("GET", `/runs/${runId}`)).json()) as { status: string }).status;

	/** 进程还活着、能回答请求。 */
	const expectAlive = async () => {
		expect(
			await cp.waitForExit(1500),
			`控制面进程退出了：\n${cp.log.slice(-1500)}`,
		).toBeUndefined();
		expect((await cp.request("GET", "/health")).status).toBe(200);
	};
	const createScenario = async (name: string) => {
		const created = (await (await cp.request("POST", "/orchestrations", { name })).json()) as {
			id: string;
		};
		return created.id;
	};

	it("HTTP 请求里的事务（保存场景版本）：这次请求以 5xx 结束，进程不退出，之后的请求照常", async () => {
		const id = await createScenario("连接被结束-请求");
		await slowDown(database.url, "orchestration_versions", "insert");
		const doomed = cp.request("POST", `/orchestrations/${id}/versions`, {
			base_version: 0,
			document: ENTRY_ONLY,
		});
		expect(await terminateActive(database.url, 'insert into "orchestration_versions"')).toBe(1);

		const res = await doomed;

		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(res.status).toBeLessThan(600);
		await expectAlive();
		// 之后的请求和写入正常；被结束的那次什么都没有留下。
		await speedUp(database.url, "orchestration_versions", "insert");
		const retried = await cp.request("POST", `/orchestrations/${id}/versions`, {
			base_version: 0,
			document: ENTRY_ONLY,
		});
		expect(retried.status).toBe(201);
	}, 90_000);

	it("引擎写任务结果的事务：进程不退出，这次尝试以明确的错误（控制面无法保存任务结果）结束，之后的运行正常", async () => {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const id = await createScenario("连接被结束-引擎");
		expect(
			(
				await cp.request("POST", `/orchestrations/${id}/versions`, {
					base_version: 0,
					document: ECHO,
				})
			).status,
		).toBe(201);
		const trigger = async () => {
			const res = await cp.request("POST", `/orchestrations/${id}/runs`, { params: {} });
			expect(res.status).toBe(201);
			return ((await res.json()) as { id: string }).id;
		};
		const runId = await trigger();
		const task = await agent.nextAssign();
		await agent.started(task);

		// 控制面写这个任务的结果（update "tasks"）时，结束它的连接。
		await slowDown(database.url, "tasks", "update", 4);
		const reporting = agent.succeed(task, { v: 1 }).catch(() => undefined);
		expect(await terminateActive(database.url, 'update "tasks"')).toBeGreaterThanOrEqual(1);
		await reporting;

		await expectAlive();
		// 已有的「数据库出错」的路径（#207）：结果写不进去，这次尝试以明确的错误结束，不是悬着、也不是进程退出。
		await eventually(async () => {
			const run = (await (await cp.request("GET", `/runs/${runId}`)).json()) as { status: string };
			expect(run.status).toBe("failed");
			expect(JSON.stringify(run)).toContain("控制面无法保存任务结果");
		}, 30_000);
		await expectAlive();

		// 之后的运行正常：Agent 重连（假 Agent 不会自己重连），新的运行派发、执行、成功。
		await speedUp(database.url, "tasks", "update");
		await agent.disconnect();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const second = await trigger();
		await agent.succeed(await agent.nextAssign(), { v: 2 });
		await eventually(async () => expect(await runStatus(second)).toBe("success"), 30_000);
		await expectAlive();
	}, 120_000);

	it("普通请求（单条语句，不在事务里）：这次请求以 5xx 结束，进程不退出", async () => {
		await slowDown(database.url, "orchestrations", "insert");
		const doomed = cp.request("POST", "/orchestrations", { name: "连接被结束-单条" });
		expect(await terminateActive(database.url, 'insert into "orchestrations"')).toBe(1);

		const res = await doomed;

		expect(res.status).toBeGreaterThanOrEqual(500);
		await expectAlive();
		await speedUp(database.url, "orchestrations", "insert");
		expect((await cp.request("POST", "/orchestrations", { name: "之后" })).status).toBe(201);
	}, 90_000);

	it("空闲的连接被结束：进程不退出，之后的请求照常", async () => {
		await cp.request("GET", "/orchestrations");
		await sleep(300);

		expect(await terminateIdle(database.url)).toBeGreaterThanOrEqual(1);

		await expectAlive();
		expect((await cp.request("POST", "/orchestrations", { name: "空闲之后" })).status).toBe(201);
	}, 90_000);
});

describe("数据库整体不可用一小段时间再恢复", () => {
	let database: TestDatabase;
	let proxy: PgProxy;
	let cp: ControlPlaneProcess;
	let agent: FakeAgent | undefined;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_dbconn");
		proxy = await PgProxy.start(database.url);
		cp = await ControlPlaneProcess.start(proxy.urlFor(database.url));
	}, 90_000);
	afterEach(async () => {
		await agent?.disconnect();
		agent = undefined;
		await cp.stop();
		await proxy.close();
		await database.drop();
	});

	it("控制面自己恢复：进程不退出，不可用期间读接口返回 503、恢复后自己好；Agent 重连之后断开时在跑的任务和之后的运行都能走完", async () => {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const created = (await (
			await cp.request("POST", "/orchestrations", { name: "不可用" })
		).json()) as { id: string };
		await cp.request("POST", `/orchestrations/${created.id}/versions`, {
			base_version: 0,
			document: ECHO,
		});
		const trigger = async () => {
			const res = await cp.request("POST", `/orchestrations/${created.id}/runs`, { params: {} });
			expect(res.status).toBe(201);
			return ((await res.json()) as { id: string }).id;
		};
		const runStatus = async (runId: string) =>
			((await (await cp.request("GET", `/runs/${runId}`)).json()) as { status: string }).status;
		const firstRun = await trigger();
		const task = await agent.nextAssign();
		await agent.started(task);

		// 数据库不可用：现有的连接全断，新连接被拒绝。Agent 的心跳在这时落到数据库出错的路径上。
		await proxy.outage();
		await agent.heartbeat([task]).catch(() => undefined);
		await sleep(2500);

		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
		expect((await cp.request("GET", "/health")).status).toBe(503);

		// 数据库恢复：控制面不重启，自己回到正常。
		await proxy.recover();
		await eventually(
			async () => expect((await cp.request("GET", "/health")).status).toBe(200),
			30_000,
		);
		// 真实的 Agent 在流断开后自己重连、带着手上的任务（见 agent/ 的重连测试）；假 Agent 不会自己重连，这里照做。
		await agent.disconnect();
		agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			runningTasks: [{ taskId: task.taskId, attempt: task.attempt, started: true }],
		});
		await agent.succeed(task, { v: 1 });
		await eventually(async () => expect(await runStatus(firstRun)).toBe("success"), 30_000);

		const secondRun = await trigger();
		await agent.succeed(await agent.nextAssign(), { v: 2 });
		await eventually(async () => expect(await runStatus(secondRun)).toBe("success"), 30_000);
		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
	}, 150_000);
});
