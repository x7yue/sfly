// 全栈（#563）：真实的控制面**进程**、真实的 Rust Agent、数据库前面放一个可以掐断的 TCP 转发。数据库整体不可用一小段时间
// 再恢复：控制面进程不退出，恢复后自己回到正常；Agent 不需要人工做任何事，任务照常跑完、运行成功，之后的运行也正常。
// 实测（Linux 容器里）：4 秒的中断里真实 Agent 的流没有断，没有重连（welcome 事件前后都是 1），任务一直在 Agent 上跑；
// Agent 断开重连之后继续手上的任务那一段（Hello/Welcome）由 Agent 和协议自己的测试管，这里不重复，下面只把 welcome 的数量
// 记在输出里、不断言它变不变。（假 Agent 版本的同类场景在 db-connection-errors.test.ts：那里的 Agent 流在中断里断了，测试照真实 Agent 的做法重连。）
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { ControlPlaneProcess } from "./support/control-plane-process.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { PgProxy } from "./support/pg-proxy.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeWithAgent("全栈：数据库整体不可用一小段时间再恢复，真实的 Agent 不需要人工做任何事", () => {
	let database: TestDatabase;
	let proxy: PgProxy;
	let cp: ControlPlaneProcess;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let api: ApiClient;

	beforeAll(async () => {
		const bin = agentBinary();
		database = await createTestDatabase("sfly_dbout");
		proxy = await PgProxy.start(database.url);
		[cp, venv] = await Promise.all([
			ControlPlaneProcess.start(proxy.urlFor(database.url)),
			createStubVenv(),
		]);
		api = new ApiClient(cp);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "outage-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.stop();
		await proxy?.close();
		await database?.drop();
		await venv?.remove();
	});

	/** 入口加一个「等待 N 秒」的节点。 */
	const waitScenario = (seconds: number) =>
		api.orchestrationWith({
			default_agent: "outage-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "wait",
					kind: "package",
					package: "sfly-stub",
					node: "sleep",
					inputs: { seconds },
				},
			],
			edges: [{ from: "entry", to: "wait", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
	const welcomes = () => agent.events.filter((e) => e.event === "welcome").length;

	it("任务在 Agent 上跑着时数据库不可用几秒再恢复：控制面进程不退出，不可用时读接口 503、恢复后 200；不用任何人工操作，任务跑完、运行成功，之后的运行也正常", async () => {
		const runId = await api.triggerOk(await waitScenario(14));
		await eventually(
			async () => expect((await api.node(runId, "wait")).status).toBe("running"),
			60_000,
		);
		const before = welcomes();

		await proxy.outage();
		await sleep(4000);
		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
		expect((await cp.request("GET", "/health")).status).toBe(503);
		await proxy.recover();

		await eventually(
			async () => expect((await cp.request("GET", "/health")).status).toBe(200),
			30_000,
		);
		// 任务在 Agent 上一直跑着：不用任何人工操作，控制面恢复后收到结果，运行成功。
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 90_000);
		expect(cp.exit, cp.log.slice(-1500)).toBeUndefined();
		// 只记录，不断言：流有没有断取决于中断多久（实测 4 秒里没有断）。
		console.log(`数据库不可用期间 Agent 的 welcome 事件：${before} → ${welcomes()}`);

		const second = await api.triggerOk(await waitScenario(1));
		await eventually(async () => expect((await api.run(second)).status).toBe("success"), 60_000);
	}, 240_000);
});
