import type { FocusAnomaly, RunFocus, RunFocusItem, RunLogLine, RunView } from "@sfly/schema";
import { AnomalyMark } from "#/focus/AnomalyNote";
import {
	anomalyText,
	formatAgo,
	latestSeriesName,
	sourceNodeName,
	valueText,
} from "#/focus/focus-format";
import { FOCUS, LOG_LEVEL_LABEL, MESSAGE, MONITOR_VIEW_LABEL, TERM } from "#/lib/copy";
import { formatClock, formatClockMs } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { OverviewTarget } from "./Overview";
import { logOrigin } from "./run-model";
import { useRunLogs } from "./use-run-logs";

/** 节点卡住或上报中断时「需要注意」里的推测：两种无新数据的说法共用。 */
const STALE_HINT = "可能是节点卡住了，或者 Agent 的指标上报中断了。";

/** 「需要注意」里一行的原因：哪个节点、为什么（异常由控制面判断，见契约 `FocusAnomalyKind`）。 */
function why(item: RunFocusItem, anomaly: FocusAnomaly, generatedAt: string): string {
	const node = sourceNodeName(item);
	const ago = formatAgo(Date.parse(generatedAt) - Date.parse(anomaly.at));
	switch (anomaly.kind) {
		case "log": {
			const level = LOG_LEVEL_LABEL[anomaly.level ?? "warn"];
			const more =
				(anomaly.count ?? 1) > 1
					? ` · 这次${TERM.attempt}共有 ${anomaly.count} 条 WARN / ERROR`
					: "";
			return `${node} 的 ${level}（${formatClock(anomaly.at)}）：${anomaly.message}${more}`;
		}
		case "stale": {
			// 一个点都没有时，异常的时间是开始执行的时间。
			if (item.last_at === null)
				return `${node} 已经执行了 ${ago}，${MESSAGE.noData}。${STALE_HINT}`;
			const every =
				item.sample_interval_ms === null ? "" : `，采样间隔 ${formatAgo(item.sample_interval_ms)}`;
			return `${node} 仍在执行，但最后一个点在 ${ago} 前${every}。${STALE_HINT}`;
		}
		case "failed":
			return `${node} 失败${anomaly.message ? `：${anomaly.message}` : "。"}`;
		case "retry":
			return `${node} 在 ${formatClock(anomaly.at)} 开始重试（${TERM.attempt} ${item.source.attempt}）${
				anomaly.message ? `，上一次${TERM.attempt}失败：${anomaly.message}` : "。"
			}`;
	}
}

/** 直达按钮：WARN / ERROR 进详情定位到那一行；没有新数据看那个节点的日志；失败和重试看它的尝试。 */
function jump(
	item: RunFocusItem,
	anomaly: FocusAnomaly,
): { label: string; target: OverviewTarget } {
	const node = sourceNodeName(item);
	const at = { chainInstanceId: item.source.chain_instance_id, nodeId: item.node_id };
	const detail = MONITOR_VIEW_LABEL.detail;
	switch (anomaly.kind) {
		case "log":
			return {
				label: `在${detail}里看这条 ${LOG_LEVEL_LABEL[anomaly.level ?? "warn"]}`,
				target: { ...at, tab: "logs", at: anomaly.at },
			};
		case "stale":
			return { label: `在${detail}里看 ${node} 的日志`, target: { ...at, tab: "logs" } };
		case "failed":
		case "retry":
			return {
				label: `在${detail}里看 ${node} 的${TERM.attempt}`,
				target: { ...at, tab: "attempts" },
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
					const anomaly = item.anomaly as FocusAnomaly;
					const { label, target } = jump(item, anomaly);
					const series = latestSeriesName(item);
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
										<span className="ml-2 font-mono text-xs text-fg-3">
											{series && `${series} `}
											{valueText(item)}
											{item.unit && ` ${item.unit}`}
										</span>
									)}
								</p>
								<p className="m-0 mt-0.5 wrap-anywhere text-fg-2">
									{why(item, anomaly, focus.generated_at)}
								</p>
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
					{logs.expired ? MESSAGE.logsExpired : "没有别的 WARN / ERROR。"}
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
								<span className={line.level === "error" ? "text-log-error" : "text-log-warn"}>
									{LOG_LEVEL_LABEL[line.level]}
								</span>
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
