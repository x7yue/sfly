import type { ActionNameCount, AttemptView, NodeRunView, RunningActionView } from "@sfly/schema";

/**
 * 动作摘要里画在检查器上的几样东西（`ActionSummaryView`）：正在做的动作怎么排、哪些名称只计数、失败一共多少个。
 * 都是纯函数，摘要的内容由控制面准备好，这里只管排版需要的整理。
 */

/**
 * 检查器的「正在做」和「动作」属于节点的哪一次尝试：最近一次开始执行的（重试的新尝试还在排队、准备时，上一次的动作和失败
 * 还在）。动作只有在 Agent 上执行的包节点才记，没有开始执行的尝试（排队中、准备中、没开始就被跳过或取消）也不可能有，
 * 所以内置节点、还没有尝试、一次都没开始的节点是 undefined，界面上就没有这两块。
 */
export function actionAttempt(
	node: Pick<NodeRunView, "kind" | "attempts"> | undefined,
): AttemptView | undefined {
	if (node?.kind !== "package") return undefined;
	return [...node.attempts].reverse().find((a) => a.started_at !== null);
}

/** 界面最多缩进 3 层（开发文档「嵌套与并发」），更深的画在第 3 层：层级从 0 数起，所以是 2。 */
const MAX_LEVEL = 2;

/** 正在做的一个动作和它画在第几层。 */
export interface RunningRow {
	action: RunningActionView;
	/** 缩进的层数，0 到 2。 */
	level: number;
}

/**
 * 正在做的动作排成树：子动作紧跟在父动作下面，同一层按开始的先后排（`id` 的先后不一定是开始的先后）。
 * 父动作不在列表里（已经结束，或者列满 50 个被挤掉）的动作自己当一棵树的根，缩进仍按它的 `depth`。
 */
export function runningRows(running: readonly RunningActionView[]): RunningRow[] {
	const ids = new Set(running.map((action) => action.id));
	const children = new Map<number, RunningActionView[]>();
	const roots: RunningActionView[] = [];
	for (const action of byStart(running)) {
		if (action.parent !== null && ids.has(action.parent)) {
			const siblings = children.get(action.parent) ?? [];
			siblings.push(action);
			children.set(action.parent, siblings);
		} else roots.push(action);
	}
	const rows: RunningRow[] = [];
	const seen = new Set<number>();
	const visit = (action: RunningActionView) => {
		if (seen.has(action.id)) return;
		seen.add(action.id);
		rows.push({ action, level: Math.min(action.depth, MAX_LEVEL) });
		for (const child of children.get(action.id) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	// 父子关系成环（被改过的 SDK）时没有根可以走到它们：照样列出来，不丢动作。
	for (const action of byStart(running)) visit(action);
	return rows;
}

const byStart = (running: readonly RunningActionView[]) =>
	[...running].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.id - b.id);

/** 一种只计数的名称，和它从什么时候起只计数（控制面时间）。 */
export interface CountOnly {
	name: string;
	since: string;
}

/** 只计数、没有明细的名称（`capped_at` 有值的），先超出的在前。 */
export const countOnlyNames = (names: readonly ActionNameCount[]): CountOnly[] =>
	names
		.flatMap((n) => (n.capped_at === null ? [] : [{ name: n.name, since: n.capped_at }]))
		.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));

/** 失败的动作一共有多少个（各名称的失败数之和）。 */
export const failedTotal = (names: readonly ActionNameCount[]): number =>
	names.reduce((sum, n) => sum + n.failed, 0);
