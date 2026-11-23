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

	beforeEach(async () => {
		database = await createTestDatabase("sfly_dbconn");
		cp = await ControlPlaneProcess.start(database.url);
	}, 90_000);
	afterEach(async () => {
		await cp.stop();
		await database.drop();
	});

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

	it("引擎结束运行的事务：进程不退出，等数据库恢复正常之后运行由已有的恢复逻辑接手，走到结束", async () => {
		const id = await createScenario("连接被结束-引擎");
		expect(
			(
				await cp.request("POST", `/orchestrations/${id}/versions`, {
					base_version: 0,
					document: ENTRY_ONLY,
				})
			).status,
		).toBe(201);
		await slowDown(database.url, "runs", "update");
		const trigger = cp.request("POST", `/orchestrations/${id}/runs`, { params: {} });
		expect(await terminateActive(database.url, 'update "runs"')).toBeGreaterThanOrEqual(1);
		await trigger.catch(() => undefined);

		await expectAlive();
		await speedUp(database.url, "runs", "update");
		const runs = async () =>
			(
				(await (await cp.request("GET", `/orchestrations/${id}/runs`)).json()) as {
					runs: Array<{ id: string; status: string }>;
				}
			).runs;
		await eventually(async () => {
			const [run] = await runs();
			expect(run?.status).toMatch(/success|failed/);
		}, 30_000);
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

	it("控制面自己恢复：进程不退出、Agent 的连接不断，不需要人工重连；断开时在跑的任务和之后的运行都能走完", async () => {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const created = (await (
			await cp.request("POST", "/orchestrations", { name: "不可用" })
		).json()) as {
			id: string;
		};
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

		// 数据库不可用：现有的连接全断，新连接被拒绝。
		await proxy.outage();
		await agent.heartbeat([task]).catch(() => undefined);
		await sleep(2500);

		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
		expect((await cp.request("GET", "/health")).status).toBe(503);

		// 数据库恢复：不重启控制面、不重连 Agent，请求和 Agent 都回到正常。
		await proxy.recover();
		await eventually(
			async () => expect((await cp.request("GET", "/health")).status).toBe(200),
			30_000,
		);
		await agent.succeed(task, { v: 1 });
		await eventually(async () => expect(await runStatus(firstRun)).toBe("success"), 30_000);

		const secondRun = await trigger();
		await agent.succeed(await agent.nextAssign(), { v: 2 });
		await eventually(async () => expect(await runStatus(secondRun)).toBe("success"), 30_000);
		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
	}, 150_000);
});
