import type { FocusAnomaly, RunFocus, RunFocusItem, RunLogLine, RunView } from "@sfly/schema";
import { AnomalyMark } from "#/focus/AnomalyNote";
import { anomalyText, formatAgo, readingValue, sourceNodeName } from "#/focus/focus-format";
import {
	FOCUS,
	LOG_ALERT_LEVELS,
	LOG_LEVEL_LABEL,
	MESSAGE,
	MONITOR_VIEW_LABEL,
	TERM,
} from "#/lib/copy";
import { formatClock, formatClockMs } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LOG_LEVEL_STYLE } from "./LogList";
import type { OverviewTarget } from "./Overview";
import { logOrigin } from "./run-model";
import { useRunLogs } from "./use-run-logs";

/**
 * 「需要注意」里的一行：写清是哪个节点、为什么（文字在 `FOCUS` 的 `…Detail`），以及直达按钮：WARN / ERROR 进详情
 * 定位到那一行，没有新数据看那个节点的日志，失败和重试看它的尝试。异常由控制面判断（契约 `FocusAnomalyKind`）。
 */
function attentionRow(
	item: RunFocusItem,
	anomaly: FocusAnomaly,
	generatedAt: string,
): { why: string; label: string; target: OverviewTarget } {
	const node = sourceNodeName(item);
	const ago = formatAgo(Date.parse(generatedAt) - Date.parse(anomaly.at));
	const at = { chainInstanceId: item.source.chain_instance_id, nodeId: item.node_id };
	const detail = MONITOR_VIEW_LABEL.detail;
	const attempts = {
		label: `在${detail}里看 ${node} 的${TERM.attempt}`,
		target: { ...at, tab: "attempts" as const },
	};
	switch (anomaly.kind) {
		case "log": {
			const level = LOG_LEVEL_LABEL[anomaly.level ?? "warn"];
			return {
				why: FOCUS.logDetail(
					node,
					level,
					formatClock(anomaly.at),
					anomaly.message,
					anomaly.count ?? 1,
				),
				label: `在${detail}里看这条 ${level}`,
				target: { ...at, tab: "logs", at: anomaly.at },
			};
		}
		case "stale":
			return {
				// 一个点都没有时，异常的时间是开始执行的时间。
				why:
					item.last_at === null
						? FOCUS.noDataDetail(node, ago)
						: FOCUS.staleDetail(
								node,
								ago,
								item.sample_interval_ms === null ? null : formatAgo(item.sample_interval_ms),
							),
				label: `在${detail}里看 ${node} 的日志`,
				target: { ...at, tab: "logs" },
			};
		case "failed":
			return { why: FOCUS.failedDetail(node, anomaly.message), ...attempts };
		case "retry":
			return {
				why: FOCUS.retryDetail(node, formatClock(anomaly.at), item.source.attempt, anomaly.message),
				...attempts,
			};
	}
}

/**
 * 概览的「需要注意」：只在有异常时出现。每个有异常的关注项一行：琥珀三角、名称和最新值，下一行写清是哪个节点、
 * 为什么，右侧是直达按钮（进详情，定位到那一行日志、那个节点的日志或尝试）。顺序与关注项的读数相同（作者的顺序）。
 */
export function Attention({
	focus,
	onOpen,
}: {
	focus: RunFocus;
	onOpen: (target: OverviewTarget) => void;
}) {
	const flagged = focus.items.filter((item) => item.anomaly);
	if (flagged.length === 0) return null;
	return (
		<section
			aria-labelledby="overview-attention"
			className="rounded-lg border border-border-soft bg-surface"
		>
			<div className="flex items-baseline gap-2.5 border-b border-border-soft px-3.5 py-2.5">
				<h2 id="overview-attention" className="m-0 text-base font-semibold">
					{FOCUS.attention}
				</h2>
				<span className="font-mono text-xs text-fg-3">{flagged.length}</span>
			</div>
			<ul className="m-0 list-none p-0">
				{flagged.map((item) => {
					const { why, label, target } = attentionRow(
						item,
						item.anomaly as FocusAnomaly,
						focus.generated_at,
					);
					return (
						<li
							key={`${item.node_id}\n${item.chart}\n${item.position}`}
							aria-label={`${item.title}，${anomalyText(item, focus.generated_at)}`}
							className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border-soft px-3.5 py-2.5 first:border-t-0"
						>
							<AnomalyMark className="mt-1.5" />
							<div className="min-w-0 text-sm">
								<p className="m-0">
									<span className="font-semibold text-fg-1">{item.title}</span>
									{!item.unavailable && item.latest && (
										<span className="ml-2 font-mono text-xs text-fg-3">{readingValue(item)}</span>
									)}
								</p>
								<p className="m-0 mt-0.5 wrap-anywhere text-fg-2">{why}</p>
							</div>
							<Button size="sm" onClick={() => onOpen(target)}>
								{label}
							</Button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

const ALERT_LEVELS = ["warn", "error"] as const;
/** 「其他警告与错误」最多列出最近的这么多条，其余在详情的日志里看。 */
const SHOWN_LINES = 20;

/** 已经在「需要注意」里出现的那几条日志：来源任务、时间、级别都对得上，正文以异常的原文（截到 500 个字符）开头。 */
function inAttention(focus: RunFocus | undefined, line: RunLogLine): boolean {
	return (focus?.items ?? []).some(
		({ anomaly, source }) =>
			anomaly?.kind === "log" &&
			source.task_id === line.task_id &&
			anomaly.at === line.time &&
			anomaly.level === line.level &&
			line.text.startsWith(anomaly.message),
	);
}

/**
 * 概览最后一段「其他警告与错误」：这次运行全部节点的 WARN / ERROR（运行日志接口按级别筛选，运行中实时追加），
 * 去掉已经出现在「需要注意」里的那几条，新的在上面，最多列 {@link SHOWN_LINES} 条。点一行进详情，日志定位到这一行。
 */
export function OtherWarnings({
	run,
	focus,
	onOpen,
}: {
	run: RunView;
	focus: RunFocus | undefined;
	onOpen: (target: OverviewTarget) => void;
}) {
	const logs = useRunLogs(run.id, undefined, ALERT_LEVELS);
	const others = logs.lines.filter((line) => !inAttention(focus, line));
	const shown = others.slice(-SHOWN_LINES).reverse();
	return (
		<section
			aria-labelledby="overview-warnings"
			className="rounded-lg border border-border-soft bg-surface px-4 py-3.5"
		>
			<div className="mb-2 flex items-baseline gap-2.5">
				<h2 id="overview-warnings" className="m-0 text-base font-semibold">
					其他警告与错误
				</h2>
				{(others.length > SHOWN_LINES || logs.hasOlder) && (
					<span className="text-xs text-fg-3">
						最近 {shown.length} 条，其余在{MONITOR_VIEW_LABEL.detail}的日志里看
					</span>
				)}
			</div>
			{logs.error ? (
				<p className="m-0 text-xs text-danger-fg">
					{MESSAGE.loadFailed("日志")}：{logs.error}
				</p>
			) : !logs.loaded ? (
				<Skeleton className="h-10 w-full" />
			) : shown.length === 0 ? (
				<p className="m-0 text-xs text-fg-3">
					{logs.expired ? MESSAGE.logsExpired : `没有别的 ${LOG_ALERT_LEVELS}。`}
				</p>
			) : (
				<ul className="m-0 list-none p-0">
					{shown.map((line) => (
						<li
							key={`${line.task_id}:${line.seq}`}
							className="border-t border-border-soft first:border-t-0"
						>
							<button
								type="button"
								onClick={() =>
									onOpen({
										chainInstanceId: line.chain_instance_id,
										nodeId: line.node_id,
										tab: "logs",
										...(line.time === null ? {} : { at: line.time }),
									})
								}
								className="grid w-full cursor-pointer grid-cols-[96px_48px_minmax(0,10rem)_minmax(0,1fr)] gap-2 py-1 text-left font-mono text-xs text-fg-2 hover:bg-fg-1/3"
							>
								<span>{line.time === null ? "—" : formatClockMs(line.time)}</span>
								<span className={LOG_LEVEL_STYLE[line.level]}>{LOG_LEVEL_LABEL[line.level]}</span>
								<span className="truncate">{logOrigin(run, line)}</span>
								<span className="truncate">{line.text}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
