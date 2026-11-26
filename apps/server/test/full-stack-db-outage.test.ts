// 全栈（#563）：真实的控制面**进程**、真实的 Rust Agent、数据库前面放一个可以掐断的 TCP 转发。数据库出问题时：
// - 此刻没有借出去的连接：控制面不退出，恢复后自己好；
// - 此刻有事务在进行（借出去的连接断了）：控制面有序退出（退出码 1），由部署的重启策略（测试里自己照做：同一个库、同一个数据目录、
//   同样的端口再起一个）拉起来，真实的 Agent 自己重连、带着手上的任务、重发结果。
// 两种情况下 Agent 都不需要人工做任何事，任务照常跑完、运行成功，之后的运行也正常（#563，docs/ARCHITECTURE.md §6.10）。
// 第一条的两种结局取决于中断那一刻碰巧有没有事务在进行（Agent 在跑、心跳不断，有时有），所以两种都接受、断言各自的后续；
// 第二条用在写任务结果的那条语句上断开，结局是确定的。
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { PgProxy } from "./support/pg-proxy.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { type SourceServer, startSourceServer } from "./support/source-server.js";
import { publishStubPackage } from "./support/stub-package.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 起一个真实的控制面进程（生产环境变量、初始管理员 root 已登录）：`dataDir` 给了就用它（同一个数据目录和库重新起一个，模拟重启策略把退出的控制面拉起来）。 */
const startProcess = (
	databaseUrl: string,
	env: Record<string, string> = {},
	options: { dataDir?: string; ports?: { http: number; grpc: number } } = {},
) => startSourceServer({ databaseUrl, env, admin: true, production: true, ...options });

/**
 * 经控制面的接口给一台 Agent 签发凭据（初始管理员 root 已登录）：Agent 要带凭据才能连（#492）。凭据在库里，控制面按同一个库
 * 重启之后照样有效，真实的 Agent 重连时带的还是它。
 */
const issueAgentCredential = async (target: SourceServer, name: string): Promise<string> => {
	const res = await target.request("POST", `/agents/${name}/credentials`, {});
	if (res.status !== 201) throw new Error(`签发 Agent 凭据失败：${res.status} ${await res.text()}`);
	return ((await res.json()) as { token: string }).token;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个现在空闲的端口（取到之后立刻放掉）：控制面重启要在同样的端口上，Agent 才能按原来的地址重连。 */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const RESULT_UPDATE = /^update "tasks" set .*"outputs" = /s;

describeWithAgent("全栈：数据库出问题，真实的 Agent 不需要人工做任何事", () => {
	let database: TestDatabase;
	let proxy: PgProxy;
	let ports: { http: number; grpc: number };
	/** 第一个控制面进程（请求都经它发：重启之后端口不变、登录凭据在库里，它的 `fetch` 照样能用）。 */
	let first: SourceServer;
	/** 现在在跑的控制面进程（重启之后是新的）。 */
	let current: SourceServer;
	const restarts: SourceServer[] = [];
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let api: ApiClient;

	beforeAll(async () => {
		const bin = agentBinary();
		database = await createTestDatabase("sfly_dbout");
		proxy = await PgProxy.start(database.url);
		ports = { http: await freePort(), grpc: await freePort() };
		[first, venv] = await Promise.all([
			startProcess(proxy.urlFor(database.url), {}, { ports }),
			createStubVenv(),
		]);
		current = first;
		api = new ApiClient(first);
		await publishStubPackage(first);
		agent = await startRealAgent({
			grpcUrl: first.grpcUrl,
			name: "outage-agent",
			venv: venv.path,
			bin,
			credential: await issueAgentCredential(first, "outage-agent"),
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		for (const process of restarts) await process.kill();
		await first?.kill();
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
	/** 部署的重启策略：同一个库、同一个数据目录、同样的端口再起一个控制面（测试里自己做）。 */
	const restart = async () => {
		const next = await startProcess(
			proxy.urlFor(database.url),
			{},
			{ dataDir: first.dataDir, ports },
		);
		restarts.push(next);
		current = next;
	};

	it("任务在 Agent 上跑着时数据库不可用几秒再恢复：控制面要么不退出、自己好，要么有序退出（退出码 1）、被重启拉起来；真实的 Agent 都不需要人工操作，任务跑完、运行成功，之后的运行也正常", async () => {
		const runId = await api.triggerOk(await waitScenario(14));
		await eventually(
			async () => expect((await api.node(runId, "wait")).status).toBe("running"),
			60_000,
		);

		await proxy.outage();
		await sleep(4000);
		// 中断那一刻碰巧有事务在进行（借出去的连接断了）就退出，没有就一直活着、读接口 503。
		const exited = await first.waitForExit(1000);
		if (exited) {
			expect(exited, first.log.slice(-1500)).toMatchObject({ code: 1 });
			expect(first.log).toContain("数据库连接在使用中断开");
		} else {
			expect((await first.request("GET", "/health")).status).toBe(503);
		}
		await proxy.recover();
		if (exited) await restart();
		await eventually(
			async () => expect((await current.request("GET", "/health")).status).toBe(200),
			60_000,
		);
		// 任务在 Agent 上一直跑着：不用任何人工操作，控制面恢复（或被重启拉起来、Agent 重连重发结果）后运行成功。
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
		console.log(`数据库不可用期间控制面${exited ? "有序退出、被重启拉起来" : "没有退出"}`);

		const second = await api.triggerOk(await waitScenario(1));
		await eventually(async () => expect((await api.run(second)).status).toBe("success"), 60_000);
	}, 300_000);

	it("真实的 Agent 报告任务结果时写结果的事务断开：控制面有序退出，没有把成功记成失败；重启之后 Agent 重连、重发结果，运行成功", async () => {
		const runId = await api.triggerOk(await waitScenario(6));
		await eventually(
			async () => expect((await api.node(runId, "wait")).status).toBe("running"),
			60_000,
		);
		const victim = current;
		// 任务结束、Agent 报结果时，写结果的那条语句上断开这条连接。
		proxy.arm(RESULT_UPDATE, "drop");

		const exit = await victim.waitForExit(60_000);

		expect(exit, victim.log.slice(-1500)).toMatchObject({ code: 1 });
		expect(victim.log).toContain("数据库连接在使用中断开");

		await restart();
		await eventually(
			async () => expect((await current.request("GET", "/health")).status).toBe(200),
			60_000,
		);
		// 写结果的失败处理没有把这次尝试记成失败（连接池在断开的那一刻就结束了，什么都写不进去）。
		expect((await api.node(runId, "wait")).status).not.toBe("failed");
		// 真实的 Agent 自己重连、重发手上的结果：运行成功，不是失败。
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
	}, 300_000);
});
