import { type AgentView, agentsApi } from "@sfly/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentHub } from "../src/agents/agent-hub.js";
import { openDatabase } from "../src/db/database.js";
import { type AgentGatewayServer, startAgentGateway } from "../src/gateway/agent-gateway.js";
import { Mutex } from "../src/util/mutex.js";
import { eventually } from "./support/eventually.js";
import { agentClock, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const DAY = 86_400_000;
const START = "2025-03-07T00:00:00.000Z";
const START_MS = Date.parse(START);

describe("Agent 的时钟偏差（#172）", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});

	async function agentView(name: string): Promise<AgentView> {
		const res = await (cp as TestControlPlane).fetch("/agents");
		expect(res.status).toBe(200);
		const agent = agentsApi.list.response
			.parse(await res.json())
			.agents.find((a) => a.name === name);
		if (!agent) throw new Error(`no agent ${name}`);
		return agent;
	}

	it("Hello 带 Agent 时间时，接口返回时钟偏差（Agent 时间 − 控制面时间）和测量时刻", async () => {
		const clock = new ManualClock(START);
		cp = await startTestControlPlane({ clock });
		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				...agentClock(START_MS + 613 * DAY, 5_000),
			}),
		);

		expect((await agentView("agent-a")).clock_offset).toEqual({
			offset_ms: 613 * DAY,
			measured_at: START,
			exceeds_threshold: true,
		});
	});

	it("每次 Heartbeat 更新时钟偏差；绝对值不到 2 秒视为一致", async () => {
		const clock = new ManualClock(START);
		cp = await startTestControlPlane({ clock });
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(START_MS, 5_000),
		});
		agents.push(agent);
		expect((await agentView("agent-a")).clock_offset).toEqual({
			offset_ms: 0,
			measured_at: START,
			exceeds_threshold: false,
		});

		// [心跳时的偏差, 是否达到阈值]：快和慢都算，1999 毫秒不算、2000 毫秒算。
		const cases: Array<[number, boolean]> = [
			[1_999, false],
			[2_000, true],
			[-1_999, false],
			[-2_000, true],
			// Agent 时间被改到 1970 年。
			[-START_MS, true],
		];
		for (const [offset, exceeds] of cases) {
			clock.advance(10_000);
			const now = clock.now().getTime();
			await agent.heartbeat([], agentClock(now + offset, 5_000 + now - START_MS));
			expect((await agentView("agent-a")).clock_offset).toEqual({
				offset_ms: offset,
				measured_at: new Date(now).toISOString(),
				exceeds_threshold: exceeds,
			});
		}
	});

	it("旧版本 Agent 不带时钟字段：连接照常，时钟偏差未知", async () => {
		const clock = new ManualClock(START);
		cp = await startTestControlPlane({ clock });
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-old" });
		agents.push(agent);
		await agent.heartbeat();

		const view = await agentView("agent-old");
		expect(view.status).toBe("online");
		expect(view.clock_offset).toBeNull();
	});

	it("换成旧版本 Agent 重新连接后，之前测得的时钟偏差不再显示", async () => {
		cp = await startTestControlPlane({ clock: new ManualClock(START) });
		const first = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(START_MS + 613 * DAY, 5_000),
		});
		await first.disconnect();
		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }));

		expect((await agentView("agent-a")).clock_offset).toBeNull();
	});

	it("带时钟字段的 Agent 发来不带时钟字段的心跳时，保存的时钟偏差不变", async () => {
		const clock = new ManualClock(START);
		cp = await startTestControlPlane({ clock });
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(START_MS + 3_000, 5_000),
		});
		agents.push(agent);
		clock.advance(10_000);
		await agent.heartbeat();

		expect((await agentView("agent-a")).clock_offset).toEqual({
			offset_ms: 3_000,
			measured_at: START,
			exceeds_threshold: true,
		});
	});
});

describe("单调时钟读数折算成控制面时间（#172）", () => {
	const clock = new ManualClock(START);
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let hub: AgentHub;
	let gateway: AgentGatewayServer;
	const agents: FakeAgent[] = [];
	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		hub = new AgentHub({ db: database.db, clock, mutex: new Mutex(), version: "1.0.0" });
		gateway = await startAgentGateway({ host: "127.0.0.1", port: 0, hub });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		clock.set(START);
	});
	afterAll(async () => {
		await gateway.close();
		await database.close();
		await testDb.drop();
	});

	const connection = (name: string) => {
		const conn = hub.connection(name);
		if (!conn) throw new Error(`agent ${name} is not connected`);
		return conn;
	};

	it("按收到 Hello 时的控制面时间和单调时钟读数折算，早于连接的读数落在连接之前", async () => {
		agents.push(
			await FakeAgent.connect(gateway.url, {
				name: "agent-a",
				// Agent 时间快 613 天，不影响折算。
				...agentClock(START_MS + 613 * DAY, 50_000),
			}),
		);
		const conn = connection("agent-a");

		expect(conn.clock.occurredAt(50_000)?.toISOString()).toBe(START);
		expect(conn.clock.occurredAt(53_250n)?.toISOString()).toBe("2025-03-07T00:00:03.250Z");
		// 断线期间排队的数据：发生在这次连接之前 20 秒。
		expect(conn.clock.occurredAt(30_000)?.toISOString()).toBe("2025-03-06T23:59:40.000Z");
	});

	it("同一次连接内折算结果不变：心跳带来新的读数、Agent 时间跳变、控制面时间流逝都不影响", async () => {
		const agent = await FakeAgent.connect(gateway.url, {
			name: "agent-a",
			...agentClock(START_MS, 50_000),
		});
		agents.push(agent);
		const conn = connection("agent-a");
		const before = conn.clock.occurredAt(60_000)?.toISOString();
		expect(before).toBe("2025-03-07T00:00:10.000Z");

		// 心跳晚到了 3 秒（单调时钟只走了 10 秒，控制面过了 13 秒），Agent 时间还往前跳了 613 天。
		clock.advance(13_000);
		agent.send({ case: "heartbeat", value: agentClock(START_MS + 613 * DAY, 60_000) });
		await eventually(async () => {
			const view = (await hub.list()).find((a) => a.name === "agent-a");
			expect(view?.clock_offset?.measured_at).toBe("2025-03-07T00:00:13.000Z");
		});

		expect(conn.clock.occurredAt(60_000)?.toISOString()).toBe(before);
	});

	it("重新连接后按新的 Hello 重新建立对应关系", async () => {
		const first = await FakeAgent.connect(gateway.url, {
			name: "agent-a",
			...agentClock(START_MS, 50_000),
		});
		await first.disconnect();
		clock.advance(60_000);
		// 机器重启过：单调时钟从头开始。
		agents.push(
			await FakeAgent.connect(gateway.url, { name: "agent-a", ...agentClock(START_MS, 1_000) }),
		);

		expect(connection("agent-a").clock.occurredAt(2_000)?.toISOString()).toBe(
			"2025-03-07T00:01:01.000Z",
		);
	});

	it("旧版本 Agent 的连接没有对应关系：没法折算，控制面时间兜底为收到消息的时刻", async () => {
		agents.push(await FakeAgent.connect(gateway.url, { name: "agent-old" }));
		const conn = connection("agent-old");
		clock.advance(5_000);
		const receivedAt = clock.now();

		expect(conn.clock.occurredAt(0)).toBeUndefined();
		expect(conn.clock.controlPlaneTime(0, receivedAt)).toEqual(receivedAt);
		// 就算消息里带了读数，没有对应关系也无从折算。
		expect(conn.clock.occurredAt(123_456)).toBeUndefined();
		expect(conn.clock.controlPlaneTime(123_456, receivedAt)).toEqual(receivedAt);
	});

	it("新版本 Agent 的消息没带读数（0）时同样兜底为收到消息的时刻，带读数时不用兜底", async () => {
		agents.push(
			await FakeAgent.connect(gateway.url, { name: "agent-a", ...agentClock(START_MS, 50_000) }),
		);
		clock.advance(5_000);
		const conn = connection("agent-a");

		expect(conn.clock.occurredAt(0n)).toBeUndefined();
		expect(conn.clock.controlPlaneTime(0n, clock.now()).toISOString()).toBe(
			"2025-03-07T00:00:05.000Z",
		);
		expect(conn.clock.controlPlaneTime(51_000n, clock.now()).toISOString()).toBe(
			"2025-03-07T00:00:01.000Z",
		);
	});
});
