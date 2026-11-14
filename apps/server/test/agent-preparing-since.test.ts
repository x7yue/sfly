// #296：GET /agents 的 preparing_since 是这次连接发出 Welcome 的控制面时间；准备好（Welcome 之后的第一次心跳）和离线时为 null。
import { agentsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;

describe("GET /agents 的 preparing_since", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const listed = async (name: string) => {
		const body = agentsApi.list.response.parse(await (await cp.fetch("/agents")).json());
		const agent = body.agents.find((a) => a.name === name);
		if (!agent) throw new Error(`列表里没有 ${name}`);
		return agent;
	};

	it("准备环境中是发出 Welcome 的时刻，仍然在线；发出第一次心跳后为 null", async () => {
		clock.advance(10 * SECOND);
		const welcomedAt = clock.now().toISOString();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { preparing: true });
		agents.push(agent);

		// 准备了一阵子：时间从发出 Welcome 的那一刻起算，不随时间移动。
		clock.advance(130 * SECOND);
		expect(await listed("agent-a")).toMatchObject({
			status: "online",
			preparing_since: welcomedAt,
		});

		await agent.ready();
		expect(await listed("agent-a")).toMatchObject({ status: "online", preparing_since: null });
	});

	it("准备环境中断开后为 null；重连后重新从新的 Welcome 起算", async () => {
		const first = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { preparing: true });
		await first.disconnect();
		await eventually(async () => {
			expect(await listed("agent-a")).toMatchObject({ status: "offline", preparing_since: null });
		});

		clock.advance(60 * SECOND);
		const reconnectedAt = clock.now().toISOString();
		const second = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { preparing: true });
		agents.push(second);
		expect(await listed("agent-a")).toMatchObject({ preparing_since: reconnectedAt });
	});

	it("已准备好的 Agent 和已离线的 Agent 都是 null", async () => {
		const ready = await FakeAgent.connect(cp.grpcUrl, { name: "agent-ready" });
		agents.push(ready);
		const gone = await FakeAgent.connect(cp.grpcUrl, { name: "agent-gone" });
		await gone.disconnect();

		expect((await listed("agent-ready")).preparing_since).toBeNull();
		await eventually(async () => {
			expect(await listed("agent-gone")).toMatchObject({
				status: "offline",
				preparing_since: null,
			});
		});
	});
});
