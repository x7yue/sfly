import type { RunningTaskView } from "@sfly/schema";
import { cn } from "cn";
import { NodeName, runNodeName } from "#/components/node-name";
import { nodeStatusView, STATUS, StatusDot } from "#/components/status";
import { namedChainLabel, TERM } from "#/lib/copy";
import { formatDuration, shortId } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { Truncate } from "@/components/ui/truncate";

/**
 * 槽位格：Agent 上一个被占用的槽位，写这个任务的节点、场景、运行编号、所在链、尝试号、节点类型和已执行时长。
 * Agent 管理页的机架用它；以后控制台的 Agent 列（#363）也用它，不另画一份。目前控制台用的是 `SlotBar`。
 *
 * 系统里没有槽位身份，`running_tasks` 只是按派发顺序排列，所以格子不写「槽 1」这样的编号。
 * 调用方在格子底部追加内容（正在做的动作、关注项）时，作为 `children` 传入，并用 `summary` 把这些内容的要点
 * 补进格子的可访问名称。格子放在 `<ul>` 里，空闲的槽位用 {@link IdleSlots}。
 */
export function SlotCell({
	task,
	summary,
	children,
}: {
	task: RunningTaskView;
	/** 追加在可访问名称末尾的说明（`children` 里的动作、异常的关注项）；读屏用户不看画面，名称里要有它们。 */
	summary?: string | undefined;
	/** 追加在格子底部的内容。 */
	children?: React.ReactNode;
}) {
	const status = nodeStatusView(task.status);
	return (
		<li
			aria-label={slotLabel(task, summary)}
			// 状态表里执行中的色块是淡青底加描边；格子只取它的描边，底色用 raised（原型）。
			className={cn(
				"min-w-0 rounded-lg px-3 pt-2.25 pb-2.5",
				STATUS[status.kind].area.box,
				"bg-raised",
			)}
		>
			<div className="flex items-center gap-2">
				<StatusDot kind={status.kind} />
				<NodeName node={task} className={cn("font-medium", STATUS[status.kind].text)} />
				<span className="ml-auto flex-none font-mono text-xs text-fg-2">
					{task.started_at === null ? (
						<span className="font-sans text-fg-3">{status.label}</span>
					) : (
						<Elapsed since={task.started_at} />
					)}
				</span>
			</div>
			<div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
				<Truncate>{task.orchestration_name}</Truncate>
				<span className="flex-none font-mono text-2xs text-fg-3">{shortId(task.run_id)}</span>
			</div>
			<div className="mt-0.5 flex min-w-0 text-xs text-fg-3">
				<Truncate>{`${taskChainLabel(task)} · ${TERM.attempt} ${task.attempt}`}</Truncate>
				<span className="flex-none whitespace-pre"> · </span>
				<Truncate className="font-mono">{task.node_type}</Truncate>
			</div>
			{children}
		</li>
	);
}

/** 连续的空闲槽合并成一行矮条：不随旁边的格子拉伸（放在 `items-start` 的网格里）。 */
export function IdleSlots({ count }: { count: number }) {
	return (
		<li className="min-w-0 rounded-lg border border-border-soft bg-sunk px-3 py-2.25 text-xs text-fg-3">
			{count} 个槽位空闲
		</li>
	);
}

/** 没被占用的槽位数。 */
export const idleSlotCount = (slots: number, running: number): number =>
	Math.max(0, slots - running);

/** 任务所在链的名称：「主链」或「子流程 <名称>」（`chain_name` 为 null 是主链）。 */
export const taskChainLabel = (task: Pick<RunningTaskView, "chain_name">): string =>
	namedChainLabel(task.chain_name);

/** 格子的可访问名称：节点、场景，以及调用方补充的说明。 */
export const slotLabel = (
	task: Pick<RunningTaskView, "node_id" | "display_name" | "orchestration_name">,
	summary?: string,
): string =>
	[
		`${TERM.node} ${runNodeName(task)}`,
		`${TERM.scenario} ${task.orchestration_name}`,
		...(summary ? [summary] : []),
	].join("，");

/** 已执行时长，按控制面时间每秒走一次（ADR 0018）。 */
function Elapsed({ since }: { since: string }) {
	const now = useNow(true);
	return <>{formatDuration(now - new Date(since).getTime())}</>;
}
