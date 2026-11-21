import type { QueueWaitView } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { agentAnchor } from "#/agents/agent-anchor";
import { QUEUE_WAIT } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { holderNodeLabel, holdersRest, queueWaitParts } from "./queue-wait";
import { runMonitorLink } from "./run-link";

/**
 * 排队中的节点在等什么（运行视图里排队中的尝试的 `queue_wait`）：「等 agent-a（不在线，已离线 2m 10s）· 排队 3m 05s ·
 * 6m 55s 后超时」，Agent 名称是去 Agent 管理页那台 Agent 的链接；槽位占满时后面接占着槽位的任务。概览的「进行中」、
 * 没有执行中节点时的说明、详情里尝试卡片共用。`now` 是控制面时间（毫秒）。
 */
export function QueueWaitNote({
	wait,
	queuedAt,
	now,
	className,
}: {
	wait: QueueWaitView;
	queuedAt: string;
	now: number;
	className?: string;
}) {
	const parts = queueWaitParts(wait, queuedAt, now);
	const { situation, timing, holders } = parts;
	const rest = holdersRest(parts, holders.length > 0);
	return (
		<span data-testid="queue-wait" data-state={wait.state} className={className}>
			{QUEUE_WAIT.waitingFor}{" "}
			<Link
				to="/agents"
				hash={agentAnchor(wait.agent)}
				className="font-mono text-fg-1 underline decoration-border-strong underline-offset-2 hover:decoration-fg-2"
			>
				{wait.agent}
			</Link>
			（{situation}）· <span className="whitespace-nowrap">{timing}</span>
			{(holders.length > 0 || rest !== "") && (
				<span data-testid="queue-wait-holders">
					；{QUEUE_WAIT.holders}：
					{holders.map((holder, i) => (
						<span key={`${holder.run_id}/${holder.node_id}/${holder.attempt}`}>
							{i > 0 && "、"}
							{holder.orchestration_name}（
							<Link
								{...runMonitorLink(holder.run_id, { node: holder.node_id })}
								className="font-mono text-fg-1 underline decoration-border-strong underline-offset-2 hover:decoration-fg-2"
							>
								{QUEUE_WAIT.holderRun(shortId(holder.run_id))}
							</Link>
							）的 {holderNodeLabel(holder)}
						</span>
					))}
					{holders.length > 0 && rest !== "" && "，"}
					{rest}
				</span>
			)}
		</span>
	);
}
