import type { AgentView, RunFocusItem, RunningTaskView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { agentColumn, agentCountLabel, readoutCells, readoutPlan, wallLayout } from "./wall-rules";

describe("运行个数", () => {
	it("1、2 个运行：运行块，进行中的节点全列", () => {
		expect(wallLayout(1)).toEqual({ compact: false, activeLimit: null });
		expect(wallLayout(2)).toEqual({ compact: false, activeLimit: null });
	});

	it("3 到 5 个运行：运行块，进行中的节点只列前 2 个", () => {
		for (const runs of [3, 4, 5])
			expect(wallLayout(runs)).toEqual({ compact: false, activeLimit: 2 });
	});

	it("6 个以上运行：一行一个的紧凑行，点开的运行块同样只列前 2 个", () => {
		for (const runs of [6, 12]) expect(wallLayout(runs)).toEqual({ compact: true, activeLimit: 2 });
	});
});

const task = (id: string): RunningTaskView => ({
	task_id: id,
	run_id: "r",
	orchestration_id: "o",
	orchestration_name: "巡检",
	node_id: "ping",
	node_type: "demo-checks/ping",
	chain_instance_id: "c",
	chain_name: null,
	attempt: 1,
	status: "running",
	started_at: "2026-01-01T00:00:00.000Z",
	current_action: null,
	progress: null,
});

function agent(name: string, overrides: Partial<AgentView> = {}): AgentView {
	return {
		name,
		status: "online",
		info: { agent_version: "0.1.0", os: "linux", arch: "x86_64", slots: 4, installed_packages: [] },
		last_seen_at: "2026-01-01T00:00:00.000Z",
		preparing_since: null,
		installed_packages: [],
		install: null,
		dev_packages: [],
		running_tasks: [],
		queued_tasks: [],
		other_project_running: 0,
		other_project_queued: 0,
		version_mismatch: false,
		update: { state: "none", remaining_tasks: 0, reason: "" },
		clock_offset: null,
		referencing_orchestrations: 0,
		capabilities: [],
		endpoint: {
			address: "10.0.0.1",
			address_source: "connection",
			port: 50052,
			unavailable_reason: null,
		},
		auth_kind: "agent",
		disabled_at: null,
		...overrides,
	};
}

const names = (agents: AgentView[]) => agents.map((a) => a.name);

describe("Agent 合并", () => {
	it("不超过 5 台时全列，空闲的也列出来", () => {
		const agents = ["a", "b", "c", "d", "e"].map((n) => agent(n));
		expect(agentColumn(agents)).toEqual({ listed: agents, idle: 0 });
	});

	it("更多时只列忙碌、离线、更新中的，其余在线空闲的合并成一个数", () => {
		const { listed, idle } = agentColumn([
			agent("busy", { running_tasks: [task("t1")] }),
			agent("idle-1"),
			agent("offline", { status: "offline" }),
			agent("idle-2"),
			agent("updating", {
				version_mismatch: true,
				update: { state: "downloading", remaining_tasks: 0, reason: "" },
			}),
			agent("waiting", {
				queued_tasks: [
					{ ...task("t2"), queued_at: "2026-01-01T00:00:00.000Z", queue_expires_at: null },
				],
			}),
			agent("idle-3"),
		]);
		expect(names(listed)).toEqual(["busy", "offline", "updating", "waiting"]);
		expect(idle).toBe(3);
	});

	it("安装节点包中、版本不一致的 Agent 也单独列出", () => {
		const { listed, idle } = agentColumn([
			agent("installing", {
				install: { package: "demo", version: "1.0.0", state: "installing", task_id: "t" },
			}),
			agent("mismatch", { version_mismatch: true }),
			...["a", "b", "c", "d"].map((n) => agent(n)),
		]);
		expect(names(listed)).toEqual(["installing", "mismatch"]);
		expect(idle).toBe(4);
	});

	it("准备环境中的 Agent 还不接任务，不算空闲，单独列出", () => {
		const { listed, idle } = agentColumn([
			agent("preparing", { preparing_since: "2026-01-01T00:00:00.000Z" }),
			...["a", "b", "c", "d", "e"].map((n) => agent(n)),
		]);
		expect(names(listed)).toEqual(["preparing"]);
		expect(idle).toBe(5);
	});
});

describe("已停用的 Agent（#492）", () => {
	const DISABLED = "2026-01-01T00:00:00.000Z";

	it("不接任务，不算空闲：Agent 多了合并空闲的在线 Agent 时，停用的照样单独列出", () => {
		const { listed, idle } = agentColumn([
			agent("disabled", { status: "offline", disabled_at: DISABLED }),
			// 停用到连接真的关掉之间有一瞬还在线：也不算空闲。
			agent("closing", { status: "online", disabled_at: DISABLED }),
			...["a", "b", "c", "d", "e"].map((n) => agent(n)),
		]);
		expect(names(listed)).toEqual(["disabled", "closing"]);
		expect(idle).toBe(5);
	});

	it("计数：分母不含已停用的，有停用的接「N 台已停用」，没有停用的不写", () => {
		expect(agentCountLabel([agent("a"), agent("b", { status: "offline" })])).toBe("1 / 2 在线");
		expect(
			agentCountLabel([
				agent("a"),
				agent("b", { status: "offline" }),
				agent("c", { status: "offline", disabled_at: DISABLED }),
			]),
		).toBe("1 / 2 在线 · 1 台已停用");
		// 刚停用、连接还没关掉的那一瞬也不算在线。
		expect(agentCountLabel([agent("a"), agent("b", { disabled_at: DISABLED })])).toBe(
			"1 / 1 在线 · 1 台已停用",
		);
		expect(agentCountLabel([])).toBe("0 / 0 在线");
	});
});

describe("读数区放几格", () => {
	// 运行块内容的实际宽度：1440 的窗口里约 753px，1280 的窗口里约 624px。
	const WIDE = 753;
	const NARROW = 624;

	it("按运行块的宽度放 4 格或 3 格（「还有 N 个关注项」也占一格）", () => {
		expect(readoutCells(WIDE, null)).toBe(4);
		expect(readoutCells(NARROW, null)).toBe(3);
	});

	it("宽度的分界：5 列各至少 140px 才放 4 格；再宽也不超过 4 格，再窄也不少于 3 格", () => {
		expect(readoutCells(699, null)).toBe(3);
		expect(readoutCells(700, null)).toBe(4);
		expect(readoutCells(1400, null)).toBe(4);
		expect(readoutCells(200, null)).toBe(3);
		expect(readoutCells(0, null)).toBe(3);
	});

	it("3 个以上运行时每块只放前 2 项，不看宽度", () => {
		for (const runs of [3, 6])
			for (const width of [NARROW, WIDE])
				expect(readoutCells(width, wallLayout(runs).activeLimit)).toBe(2);
		expect(readoutCells(WIDE, wallLayout(2).activeLimit)).toBe(4);
	});
});

const warn: RunFocusItem["anomaly"] = {
	kind: "log",
	level: "warn",
	at: "2026-01-01T00:10:00.000Z",
	message: "超时",
};
const item = (name: string, anomaly = false) => ({ name, anomaly: anomaly ? warn : null });
const titles = (items: readonly { name: string }[]) => items.map((i) => i.name);

describe("读数区显示哪几项、排几列", () => {
	// 控制面给的读数：有异常的在最前，其余按作者的顺序。
	const ITEMS = [
		item("a", true),
		item("b", true),
		item("c"),
		item("d"),
		item("e"),
		item("f"),
		item("g"),
	];

	it("取前几格，其余只计数", () => {
		const wide = readoutPlan(ITEMS, 753, null);
		expect(titles(wide.shown)).toEqual(["a", "b", "c", "d"]);
		expect(wide.more).toBe(3);
		const narrow = readoutPlan(ITEMS, 624, null);
		expect(titles(narrow.shown)).toEqual(["a", "b", "c"]);
		expect(narrow.more).toBe(4);
	});

	it("3 个以上运行时是有异常的加上前两项：异常不到两项时补满两项", () => {
		const one = readoutPlan([item("a", true), item("b"), item("c")], 753, 2);
		expect(titles(one.shown)).toEqual(["a", "b"]);
		expect(one.more).toBe(1);
		const none = readoutPlan([item("a"), item("b"), item("c")], 753, 2);
		expect(titles(none.shown)).toEqual(["a", "b"]);
	});

	it("有异常的总在里面：异常比格数多时全部显示，不够的格数不补", () => {
		const items = [
			item("a", true),
			item("b", true),
			item("c", true),
			item("d", true),
			item("e", true),
			item("f"),
		];
		const narrow = readoutPlan(items, 624, null);
		expect(titles(narrow.shown)).toEqual(["a", "b", "c", "d", "e"]);
		expect(narrow.more).toBe(1);
		const crowded = readoutPlan(items, 753, 2);
		expect(titles(crowded.shown)).toEqual(["a", "b", "c", "d", "e"]);
		expect(crowded.more).toBe(1);
	});

	it("项数不超过格数时全部显示，没有「还有」", () => {
		const few = readoutPlan([item("a"), item("b")], 753, null);
		expect(titles(few.shown)).toEqual(["a", "b"]);
		expect(few.more).toBe(0);
		expect(readoutPlan([], 753, null)).toEqual({ shown: [], more: 0, columns: 0 });
	});

	it("列数：显示的项数加上「还有 N 个关注项」那一格，最多是按宽度能放的格数加一；异常换行时不超过它", () => {
		expect(readoutPlan(ITEMS, 753, null).columns).toBe(5);
		expect(readoutPlan(ITEMS, 624, null).columns).toBe(4);
		expect(readoutPlan([item("a"), item("b")], 753, null).columns).toBe(2);
		expect(readoutPlan(ITEMS, 753, 2).columns).toBe(3);
		const crowded = [1, 2, 3, 4, 5, 6].map((n) => item(`a${n}`, true));
		expect(readoutPlan(crowded, 624, null).columns).toBe(4);
	});
});
