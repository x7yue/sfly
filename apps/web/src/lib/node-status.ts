import type { LastRunNodeStatus, NodeStatus } from "@sfly/schema";
import type { NodeRunState } from "#/components/canvas/context";
import type { StatusKind } from "#/components/status";
import type { SegmentKind } from "#/monitor/timeline-model";

/**
 * 节点状态在界面上的显示规则，各处都从这张表读取：状态徽标、链路进度条与场景缩略图、
 * 编排画布的运行状态叠加（editor/run-state）、运行监控页的时间线与底部面板（monitor）。
 *
 * 新增节点状态只改这里：表的类型是 Record<NodeStatus, …>，漏写一项类型检查就会报错。
 */
export interface NodeStatusDisplay {
	/** 中文标签。 */
	label: string;
	kind: StatusKind;
	/** 编排画布运行状态：节点卡片、小地图与连线。 */
	canvas: NodeRunState;
	/** 在链路进度里算已完成（「主链 2/3」的分子）。 */
	done: boolean;
	/**
	 * 时间线上处于这个状态的一次尝试的执行段。ok / run 是正常执行，定时 / Sleep 节点的正常执行画成等待段；
	 * 其余种类不论节点类型都照画。没有开始执行的尝试只有排队段，用不到这一列。
	 */
	segment: SegmentKind;
	/** 节点没有执行过（没有尝试）时，底部面板的提示，接在节点 ID 后面。 */
	notRun: string;
	/** 节点没有执行过时，时间线节点行的耗时一栏。 */
	notRunDuration: string;
}

export const NODE_STATUS: Record<NodeStatus, NodeStatusDisplay> = {
	pending: {
		label: "待执行",
		kind: "pending",
		canvas: "pending",
		done: false,
		segment: "run",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	queued: {
		label: "排队中",
		kind: "queued",
		canvas: "pending",
		done: false,
		segment: "run",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	// 已派发给 Agent，还在下载、安装节点包或启动执行器。
	dispatched: {
		label: "准备中",
		kind: "running",
		canvas: "running",
		done: false,
		segment: "run",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	running: {
		label: "执行中",
		kind: "running",
		canvas: "running",
		done: false,
		segment: "run",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	waiting: {
		label: "等待中",
		kind: "warn",
		canvas: "waiting",
		done: false,
		segment: "wait",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	success: {
		label: "成功",
		kind: "ok",
		canvas: "done",
		done: true,
		segment: "ok",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	failed: {
		label: "失败",
		kind: "failed",
		canvas: "failed",
		done: false,
		segment: "fail",
		notRun: "还没有开始执行。",
		notRunDuration: "—",
	},
	skipped: {
		label: "已跳过",
		kind: "skipped",
		canvas: "skipped",
		done: true,
		segment: "run",
		notRun: "已跳过，没有执行。",
		notRunDuration: "跳过",
	},
	cancelled: {
		label: "已取消",
		kind: "cancelled",
		canvas: "cancelled",
		done: false,
		segment: "cancel",
		notRun: "在开始前被取消，没有执行。",
		notRunDuration: "—",
	},
	// 所在子流程被停止子流程节点停止（docs/SEMANTICS.md §4.1）：场景的正常流程，不算失败，链路进度里算已完成。
	stopped: {
		label: "已停止",
		kind: "stopped",
		canvas: "stopped",
		done: true,
		segment: "stop",
		notRun: "子流程被停止，没有执行。",
		notRunDuration: "停止",
	},
};

/** 按状态字符串查显示规则；不认识的状态（例如更新的控制面新增的）返回 undefined，由调用方兜底。 */
export const nodeStatusDisplay = (status: string): NodeStatusDisplay | undefined =>
	Object.hasOwn(NODE_STATUS, status) ? NODE_STATUS[status as NodeStatus] : undefined;

/**
 * 场景列表「最近一次运行」的节点状态在 schema 里另有一份枚举（packages/schema 的 orchestrations.ts），
 * 缩略图用这张表给它着色，所以两份枚举必须一致：不一致时这里类型检查报错。
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies SameUnion<LastRunNodeStatus, NodeStatus>;
