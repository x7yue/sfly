// 任务开始和结束时的时钟偏差（#175，ADR 0018）：假 Agent 加手动时钟，从运行接口观察。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type AttemptView } from "./support/api-client.js";
import { agentClock, ErrorKind, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DAY = 86_400_000;
const START = "2025-03-07T00:00:00.000Z";
const START_MS = Date.parse(START);
/** 控制面时间 START 之后 ms 毫秒。 */
const at = (ms: number) => new Date(START_MS + ms).toISOString();

/** 入口节点 + 一个 stub 包节点。 */
const document = (node: Record<string, unknown> = {}) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo", ...node },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("任务开始和结束时的时钟偏差（#175）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock(START);
		// 假 Agent 不发心跳：租约要比用例里推进的时间长。
		cp = await startTestControlPlane({ clock, leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	/** 连上假 Agent：单调时钟读数 5000 对应控制面时间 START。 */
	async function connect(agentTimeMs?: number): Promise<FakeAgent> {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...(agentTimeMs === undefined ? {} : agentClock(agentTimeMs, 5_000)),
		});
		agents.push(agent);
		return agent;
	}
	/** 控制面时间 START 之后 ms 毫秒时，偏差为 offsetMs 的 Agent 读到的时钟。 */
	const reading = (ms: number, offsetMs: number) =>
		agentClock(START_MS + ms + offsetMs, 5_000 + ms);

	async function attempts(runId: string): Promise<AttemptView[]> {
		const run = await api.run(runId);
		return run.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts ?? [];
	}

	it("执行中途改过 Agent 时间：开始和结束的偏差各自记录，开始、结束时间仍是收到消息的时刻", async () => {
		const agent = await connect(START_MS + 613 * DAY);
		const runId = await api.triggerOk(await api.orchestrationWith(document()));
		const task = await agent.nextAssign({ start: false });

		clock.advance(1_000);
		await agent.started(task, reading(1_000, 613 * DAY));
		// 执行了 60 秒；其间 Agent 时间被改成比控制面慢 3 秒。
		clock.advance(60_000);
		await agent.succeed(task, {}, reading(61_000, -3_000));

		expect(await attempts(runId)).toMatchObject([
			{
				status: "success",
				started_at: at(1_000),
				ended_at: at(61_000),
				start_clock_offset: {
					offset_ms: 613 * DAY,
					measured_at: at(1_000),
					exceeds_threshold: true,
				},
				end_clock_offset: { offset_ms: -3_000, measured_at: at(61_000), exceeds_threshold: true },
			},
		]);
	});

	it("偏差不到 2 秒时照样记录，但不算超过阈值", async () => {
		const agent = await connect(START_MS + 1_000);
		const runId = await api.triggerOk(await api.orchestrationWith(document()));
		const task = await agent.nextAssign({ clock: reading(0, 1_000) });
		clock.advance(10_000);
		await agent.succeed(task, {}, reading(10_000, -1_999));

		expect(await attempts(runId)).toMatchObject([
			{
				start_clock_offset: { offset_ms: 1_000, measured_at: at(0), exceeds_threshold: false },
				end_clock_offset: { offset_ms: -1_999, measured_at: at(10_000), exceeds_threshold: false },
			},
		]);
	});

	it("失败和被取消的任务同样记下结束时的偏差；重试的每次尝试各记各的", async () => {
		const agent = await connect(START_MS);
		const runId = await api.triggerOk(await api.orchestrationWith(document({ retries: 1 })));
		const first = await agent.nextAssign({ clock: reading(0, 5_000) });
		clock.advance(1_000);
		await agent.fail(first, "boom", ErrorKind.NODE_ERROR, reading(1_000, 7_000));
		const second = await agent.nextAssign({ clock: reading(1_000, 7_000) });
		clock.advance(1_000);
		await api.cancelOk(runId);
		await agent.nextCancel();
		await agent.cancelled(second, "任务已取消", reading(2_000, -86_400_000));

		expect(await attempts(runId)).toMatchObject([
			{
				status: "failed",
				start_clock_offset: { offset_ms: 5_000, measured_at: at(0) },
				end_clock_offset: { offset_ms: 7_000, measured_at: at(1_000) },
			},
			{
				status: "cancelled",
				start_clock_offset: { offset_ms: 7_000, measured_at: at(1_000) },
				end_clock_offset: { offset_ms: -86_400_000, measured_at: at(2_000) },
			},
		]);
	});

	it("结果晚到（断线期间排队）时，偏差按结束那一刻算，结束时间仍是收到的时刻", async () => {
		const agent = await connect(START_MS + 5_000);
		const runId = await api.triggerOk(await api.orchestrationWith(document()));
		const task = await agent.nextAssign({ clock: reading(0, 5_000) });
		// 任务在第 10 秒结束，结果第 40 秒才送到。
		clock.advance(40_000);
		await agent.succeed(task, {}, reading(10_000, 5_000));

		expect(await attempts(runId)).toMatchObject([
			{
				started_at: at(0),
				ended_at: at(40_000),
				end_clock_offset: { offset_ms: 5_000, measured_at: at(10_000), exceeds_threshold: true },
			},
		]);
	});

	it("旧版 Agent 不带时钟读数：任务照常开始和结束，偏差为空", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(document()));
		const task = await agent.nextAssign();
		clock.advance(2_000);
		await agent.succeed(task);

		expect(await attempts(runId)).toMatchObject([
			{
				status: "success",
				started_at: at(0),
				ended_at: at(2_000),
				start_clock_offset: null,
				end_clock_offset: null,
			},
		]);
	});

	it("TaskStarted 丢失、由心跳补记开始的任务：开始时的偏差为空", async () => {
		const agent = await connect(START_MS + 5_000);
		const runId = await api.triggerOk(await api.orchestrationWith(document()));
		const task = await agent.nextAssign({ start: false });
		clock.advance(1_000);
		// 心跳说任务已经启动，但 TaskStarted 没有送到。
		agent.send({
			case: "heartbeat",
			value: {
				...reading(1_000, 5_000),
				runningTasks: [{ taskId: task.taskId, attempt: task.attempt, started: true }],
			},
		});
		await agent.sync();

		expect(await attempts(runId)).toMatchObject([
			{ status: "running", started_at: at(1_000), start_clock_offset: null },
		]);
	});
});
