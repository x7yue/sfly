import type { QueueWaitView, SlotHolderView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { queueWaitParts, queueWaitText } from "./queue-wait";

const NOW = Date.parse("2026-01-01T00:05:00.000Z");
const QUEUED_AT = "2026-01-01T00:01:55.000Z"; // 排了 3m 05s

const wait = (over: Partial<QueueWaitView>): QueueWaitView => ({
	agent: "agent-a",
	now: "2026-01-01T00:05:00.000Z",
	state: "offline",
	since: null,
	expires_at: null,
	slots: null,
	holders: [],
	other_project_holders: 0,
	...over,
});

const holder = (node: string, over: Partial<SlotHolderView> = {}): SlotHolderView => ({
	run_id: "5e2d1c7a-0000-4000-8000-000000000001",
	orchestration_id: "o1",
	orchestration_name: "撮合压测",
	node_id: node,
	chain_name: null,
	attempt: 1,
	status: "running",
	started_at: null,
	...over,
});

describe("排队中的节点在等什么", () => {
	it("Agent 不在线：写明离线多久、排了多久、多久后超时（和 Agent 管理页排队行同一个写法）", () => {
		const parts = queueWaitParts(
			wait({ since: "2026-01-01T00:02:50.000Z", expires_at: "2026-01-01T00:11:55.000Z" }),
			QUEUED_AT,
			NOW,
		);
		expect(parts.situation).toBe("不在线，已离线 2m 10s");
		expect(parts.timing).toBe("排队 3m 05s · 6m 55s 后超时");
	});

	it("从没连上过的 Agent 没有最后在线的时间；没有排队超时的只写排了多久", () => {
		expect(queueWaitText(wait({}), QUEUED_AT, NOW)).toBe("等 agent-a（不在线）· 排队 3m 05s");
	});

	it("过了排队超时、控制面还没扫到：即将超时", () => {
		const parts = queueWaitParts(wait({ expires_at: "2026-01-01T00:04:59.000Z" }), QUEUED_AT, NOW);
		expect(parts.timing).toBe("排队 3m 05s · 即将超时");
	});

	it("准备环境中、版本不一致、正在派发", () => {
		expect(
			queueWaitParts(
				wait({ state: "preparing", since: "2026-01-01T00:03:50.000Z", slots: 4 }),
				QUEUED_AT,
				NOW,
			).situation,
		).toBe("准备环境中 1m 10s");
		expect(queueWaitParts(wait({ state: "version_mismatch" }), QUEUED_AT, NOW).situation).toBe(
			"版本与控制面不一致，不派新任务",
		);
		expect(queueWaitParts(wait({ state: "dispatching", slots: 4 }), QUEUED_AT, NOW).situation).toBe(
			"正在派发",
		);
	});

	it("槽位占满：写明占着槽位的任务，最多 3 个，其余写「还有 N 个」；子流程里的节点前面写子流程名称", () => {
		const text = queueWaitText(
			wait({
				state: "slots_full",
				slots: 5,
				holders: [
					holder("soak", { display_name: "浸泡" }),
					holder("probe", { chain_name: "监控" }),
					holder("report"),
					holder("cleanup"),
					holder("verify"),
				],
			}),
			QUEUED_AT,
			NOW,
		);
		// 每个占用者写明是哪次运行：同一场景触发两次互相抢槽位时分得开。
		expect(text).toBe(
			"等 agent-a（槽位占满，5 / 5）· 排队 3m 05s；占着槽位的任务：" +
				"撮合压测（运行 5e2d1c7a）的 浸泡（soak）、撮合压测（运行 5e2d1c7a）的 监控 / probe、" +
				"撮合压测（运行 5e2d1c7a）的 report，还有 2 个",
		);
	});

	it("槽位被别的项目的任务占着：只写个数，不写它们的场景和运行", () => {
		const own = queueWaitText(
			wait({
				state: "slots_full",
				slots: 3,
				holders: [holder("soak", { display_name: "浸泡" })],
				other_project_holders: 2,
			}),
			QUEUED_AT,
			NOW,
		);
		expect(own).toBe(
			"等 agent-a（槽位占满，3 / 3）· 排队 3m 05s；占着槽位的任务：" +
				"撮合压测（运行 5e2d1c7a）的 浸泡（soak），另有别的项目的任务 2 个",
		);
		const onlyOthers = queueWaitText(
			wait({ state: "slots_full", slots: 2, other_project_holders: 2 }),
			QUEUED_AT,
			NOW,
		);
		expect(onlyOthers).toBe(
			"等 agent-a（槽位占满，2 / 2）· 排队 3m 05s；占着槽位的任务：别的项目的任务 2 个",
		);
	});
});
