import type { ActionSummaryView, EndedActionView, RunningActionView } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { SectionHeading } from "#/components/page";
import { StatusDot } from "#/components/status";
import { NODE_ACTIONS, TERM } from "#/lib/copy";
import {
	formatClock,
	formatClockMs,
	formatDuration,
	formatFullDateTime,
	formatFullDateTimeMs,
	formatInteger,
	spansOtherDay,
} from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { useNow } from "#/lib/use-now";
import { Truncate } from "@/components/ui/truncate";
import { countOnlyNames, failedTotal, runningRows } from "./summary-model";

/**
 * 画布运行状态检查器里的两块（规格 #345，原型 `#canvas-run`）：摘要下面的「正在做」，和图表后面的「动作」区。
 * 数据都来自 `useActionSummary`；没有动作的节点两块都不画，只留进度的说明（调用方决定）。
 * 「最近 20 个」不放在这里：每秒 200 单时它只覆盖约 0.1 秒，一直在滚（设计文档 node-actions.md 第 7 节第 6 条）。
 */

/** 缩进一层的宽度（像素）。 */
const INDENT_PX = 14;

/** 开发文档里讲高频时怎么记录的那一节：页面在 `docs/guide/pages.json`，小节在那一页的标题里（有单测对着文档检查）。 */
export const GUIDE = {
	page: "sdk-reference",
	title: "开发节点（SDK 参考）",
	section: "数量上限",
} as const;

const FAILURES_LABEL = "最近的失败";

const fieldsText = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");

/** 名称和字段：放不下时各自截断，悬停或聚焦看全文。 */
function NameAndFields({
	name,
	fields,
	prefix,
}: {
	name: string;
	fields: Record<string, string>;
	/** 只读给读屏的话。 */
	prefix?: string | undefined;
}) {
	const text = fieldsText(fields);
	return (
		<span data-testid="action-name" className="flex min-w-0 items-baseline gap-1.5">
			{prefix && <span className="sr-only">{prefix}</span>}
			<Truncate className="max-w-[65%] flex-none text-fg-1">{name}</Truncate>
			{text && <Truncate className="font-mono text-fg-3">{text}</Truncate>}
		</span>
	);
}

/**
 * 「正在做」：正在进行的动作按层级缩进，写名称、字段和已持续多久（按控制面时间每秒刷新）。
 * 列满 50 个（`complete` 为 false）时可能还有没列出的，写明。
 */
export function CurrentActions({
	running,
	complete,
}: {
	running: readonly RunningActionView[];
	complete: boolean;
}) {
	const now = useNow(true);
	return (
		<section aria-label={NODE_ACTIONS.doing}>
			<SectionHeading>{NODE_ACTIONS.doing}</SectionHeading>
			<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
				{runningRows(running).map(({ action, level }) => (
					<li
						key={action.id}
						style={{ paddingInlineStart: level * INDENT_PX }}
						className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-1.5 text-xs leading-5"
					>
						<StatusDot kind="running" />
						<NameAndFields
							name={action.name}
							fields={action.fields}
							// 缩进读屏读不出来：子动作在名称前加一句。
							prefix={level > 0 ? "子动作：" : undefined}
						/>
						<span className="font-mono text-fg-2">
							{formatDuration(now - Date.parse(action.started_at))}
						</span>
					</li>
				))}
			</ul>
			{!complete && (
				<p className="m-0 mt-1.5 text-xs text-fg-3">{NODE_ACTIONS.runningIncomplete}</p>
			)}
		</section>
	);
}

/**
 * 「动作」区：每种名称的总数和失败数（动作和标记的名称在一起）、上限说明、最近的失败。
 * `attempt` 是这份摘要属于第几次尝试，节点重试过（`attempts` 大于 1）时写出来：只显示最新一次尝试的动作。
 * `day` 是运行开始的时刻：这里的时刻只写钟点，有一个时刻不在运行开始那天时全部带上日期。
 */
export function ActionArea({
	summary,
	attempt,
	attempts,
	day,
}: {
	summary: ActionSummaryView;
	attempt: number;
	attempts: number;
	day: string;
}) {
	const failures = summary.recent_failed;
	const failed = failedTotal(summary.names);
	const countOnly = countOnlyNames(summary.names);
	const otherDay = spansOtherDay(
		[...failures.map((f) => f.started_at), ...countOnly.map((c) => c.since), summary.capped_at],
		day,
	);
	return (
		<section aria-label={TERM.action}>
			<SectionHeading>
				{TERM.action}
				{attempts > 1 && (
					<span className="font-normal">
						第 {attempt} 次{TERM.attempt}
					</span>
				)}
			</SectionHeading>
			<table className="w-full border-collapse text-xs leading-5">
				<caption className="sr-only">每种名称的总数和失败数</caption>
				<thead>
					<tr className="text-fg-3">
						<th scope="col" className="pb-0.5 text-left font-normal">
							名称
						</th>
						<th scope="col" className="pb-0.5 pl-3.5 text-right font-normal">
							总数
						</th>
						<th scope="col" className="pb-0.5 pl-3.5 text-right font-normal">
							失败
						</th>
					</tr>
				</thead>
				<tbody>
					{summary.names.map((n) => (
						<tr key={n.name}>
							<th scope="row" className="w-full max-w-0 p-0 text-left font-normal text-fg-1">
								<Truncate>{n.name}</Truncate>
							</th>
							<td className="pl-3.5 text-right font-mono whitespace-nowrap text-fg-1">
								{formatInteger(n.total)}
							</td>
							<td
								className={cn(
									"pl-3.5 text-right font-mono whitespace-nowrap",
									n.failed > 0 ? "text-danger-fg" : "text-fg-3",
								)}
							>
								{formatInteger(n.failed)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{(countOnly.length > 0 || summary.capped_at !== null) && (
				<CapNote summary={summary} countOnly={countOnly} otherDay={otherDay} />
			)}
			{failures.length > 0 && (
				<>
					<SectionHeading>
						{FAILURES_LABEL}
						<span className="font-mono text-2xs">{formatInteger(failed)}</span>
					</SectionHeading>
					<ul aria-label={FAILURES_LABEL} className="m-0 list-none p-0">
						{failures.map((f) => (
							<Failure key={f.id} failure={f} otherDay={otherDay} />
						))}
					</ul>
					{failed > failures.length && (
						<p className="m-0 mt-1 text-xs text-fg-3">
							共 {formatInteger(failed)} 个，只列出最近 {failures.length} 个
						</p>
					)}
				</>
			)}
		</section>
	);
}

/** 一个失败的动作：开始的时刻、名称、字段、耗时；原因单独一行，不截断，放不下就折行。 */
function Failure({ failure, otherDay }: { failure: EndedActionView; otherDay: boolean }) {
	const reason = failure.reason?.trim() || NODE_STATUS.failed.label;
	return (
		<li className="border-t border-border-soft py-1.25 text-xs leading-4.5 first:border-t-0">
			<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-1.5">
				<span className="font-mono text-fg-3">
					{otherDay ? formatFullDateTimeMs(failure.started_at) : formatClockMs(failure.started_at)}
				</span>
				<NameAndFields name={failure.name} fields={failure.fields} />
				<span className="font-mono text-fg-3">{formatDuration(failure.duration_ms)}</span>
			</div>
			<p
				data-testid="action-reason"
				className="m-0 mt-0.5 flex min-w-0 items-start gap-1.5 text-danger-fg"
			>
				<StatusDot kind="failed" className="mt-1.25" />
				<span className="min-w-0 whitespace-pre-wrap wrap-anywhere">{reason}</span>
			</p>
		</li>
	);
}

/** 只列出这么多个只计数的名称，其余写个数。 */
const COUNT_ONLY_SHOWN = 5;

/**
 * 上限说明：哪些名称从几点起只计数，合计满了时说合计，以及开发文档里按批记录的建议。
 * 「从几点起」是第一个没有明细的动作开始的时刻，不是明细的终点：失败的动作在合计满以前仍有明细，所以只说「只计数」，
 * 合计满了（`capped_at`）单独说一句，也只说最早从几点起。
 */
function CapNote({
	summary,
	countOnly,
	otherDay,
}: {
	summary: ActionSummaryView;
	countOnly: ReturnType<typeof countOnlyNames>;
	otherDay: boolean;
}) {
	const clock = (iso: string) => (otherDay ? formatFullDateTime(iso) : formatClock(iso));
	return (
		<div data-testid="action-cap-note" className="mt-1.5 text-xs leading-4.5 text-fg-2">
			{countOnly.length > 0 && (
				<>
					<p className="m-0">
						超过上限的名称只计数，不再记录明细（失败的动作除外）；总数、失败数和最近的失败仍然准确。
					</p>
					<ul className="m-0 my-1 list-none p-0 text-fg-1">
						{countOnly.slice(0, COUNT_ONLY_SHOWN).map((c) => (
							<li key={c.name} className="min-w-0 wrap-anywhere">
								「{c.name}」从 <span className="font-mono">{clock(c.since)}</span> 起只计数
							</li>
						))}
					</ul>
					{countOnly.length > COUNT_ONLY_SHOWN && (
						<p className="m-0 mb-1">另有 {countOnly.length - COUNT_ONLY_SHOWN} 个名称也只计数。</p>
					)}
				</>
			)}
			{summary.capped_at !== null && (
				<p className="m-0">
					全部名称合计的明细已满，最早从{" "}
					<span className="font-mono">{clock(summary.capped_at)}</span> 起，失败的动作也只计数。
				</p>
			)}
			<p className="m-0 mt-1">
				高频的动作适合按批记录，写法见开发文档「
				<Link
					to="/docs/$page"
					params={{ page: GUIDE.page }}
					className="text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1"
				>
					{GUIDE.title}
				</Link>
				」的「{GUIDE.section}」。
			</p>
		</div>
	);
}
