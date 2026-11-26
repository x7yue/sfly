import {
	type ActionSummaryView,
	type CountOnlyPeriod,
	type EndedActionView,
	type RunningActionView,
	sdkCountOnlyPeriods,
} from "@sfly/schema";
import { cn } from "cn";
import { DocPageLink } from "#/components/doc-page-link";
import { Elapsed } from "#/components/elapsed";
import { SectionHeading } from "#/components/page";
import { StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { attemptLabel, moreLabel, NODE_ACTIONS, TERM } from "#/lib/copy";
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
import {
	COLUMN_WIDTH,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
import { failedTotal } from "./action-filter";
import { fieldsText } from "./action-table";
import { runningRows } from "./summary-model";

/**
 * 画布运行状态检查器里的两块（规格 #345，原型 `#canvas-run`）：摘要下面的「正在做」，和后面的「动作」区（设计里
 * 图表夹在两者之间）。数据都来自 `useActionSummary`；没有动作记录的节点两块都不画，进度的说明由调用方写在摘要里。
 * 「最近 20 个」不放在这里：每秒 200 单时它只覆盖约 0.1 秒，一直在滚（设计方案「动作」第 7 节第 6 条，
 * PR #257 的 docs/proposals/node-actions.md）。
 */

/** 缩进一层的宽度（像素）。 */
const INDENT_PX = 14;

/** 开发文档里讲高频时怎么记录的那一节：页名在 `DOC_PAGE` 里，小节在那一页的标题里（有单测对着文档检查）。 */
export const GUIDE = { page: "sdk-reference", section: "数量上限" } as const;

const FAILURES_LABEL = "最近的失败";

/** 只超过每种名称的上限（`name_limit`）时，失败的动作仍有明细。 */
const EXCEPT_FAILED = "（失败的动作除外）";

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
			<Truncate untrusted className="max-w-[65%] flex-none text-fg-1">
				{name}
			</Truncate>
			{text && (
				<Truncate untrusted className="font-mono text-fg-3">
					{text}
				</Truncate>
			)}
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
						<Elapsed since={Date.parse(action.started_at)} className="font-mono text-fg-2" />
					</li>
				))}
			</ul>
			{!complete && (
				<p className="m-0 mt-1.5 text-xs text-fg-3">
					{NODE_ACTIONS.runningIncomplete(running.length)}
				</p>
			)}
		</section>
	);
}

/**
 * 「动作」区：每种名称的计数（动作和标记的名称在一起）、上限说明、失败列表。
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
	const failed = failedTotal(summary);
	const countOnly = sdkCountOnlyPeriods(summary, {}, null).sort(
		(a, b) => Date.parse(a.from) - Date.parse(b.from),
	);
	const otherDay = spansOtherDay(
		[...failures.map((f) => f.started_at), ...countOnly.map((c) => c.from), summary.capped_at],
		day,
	);
	return (
		<section aria-label={TERM.action}>
			<SectionHeading>
				{TERM.action}
				{attempts > 1 && <span>{attemptLabel(attempt)}</span>}
			</SectionHeading>
			<Table aria-label="每种名称的总数和失败数" className="text-xs leading-5">
				<TableHeader>
					<TableRow>
						<TableHead className="px-0 py-1">名称</TableHead>
						<TableHead className="py-1 pr-0 pl-3.5 text-right">总数</TableHead>
						<TableHead className="py-1 pr-0 pl-3.5 text-right">失败</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{summary.names.map((n) => (
						<TableRow key={n.name}>
							<th
								scope="row"
								className={cn(COLUMN_WIDTH.grow, "px-0 py-0.5 text-left font-normal text-fg-1")}
							>
								<Truncate untrusted>{n.name}</Truncate>
							</th>
							<TableCell width="fit" className="py-0.5 pr-0 pl-3.5 text-right font-mono text-fg-1">
								{formatInteger(n.total)}
							</TableCell>
							<TableCell
								width="fit"
								className={cn(
									"py-0.5 pr-0 pl-3.5 text-right font-mono",
									n.failed > 0 ? "text-danger-fg" : "text-fg-3",
								)}
							>
								{formatInteger(n.failed)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{/* 只有控制面兜底丢弃过明细（被改过的 SDK，SDK 自己没超限）时也写上限说明：丢弃的段在详情的「动作」页签里。 */}
			{(countOnly.length > 0 || summary.capped_at !== null || summary.control_plane_capped) && (
				<CapNote countOnly={countOnly} totalFullAt={summary.capped_at} otherDay={otherDay} />
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
						<p className="m-0 mt-1 text-xs text-fg-3">{moreLabel(failed - failures.length)}</p>
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
				<span className="min-w-0 whitespace-pre-wrap wrap-anywhere">
					<UntrustedText text={reason} mode="text" />
				</span>
			</p>
		</li>
	);
}

/**
 * 上限说明：哪些名称从几点起只计数，合计满了时说合计，控制面另外丢弃的明细要去「动作」页签看（摘要里没有，
 * 这里读不到它们），以及开发文档里按批记录的建议。
 * 「从几点起」是第一个没有明细的动作开始的时刻，不是明细的终点：更早开始的动作结束时仍可能补上明细（失败的动作在
 * 合计满以前会补），所以只说「从这个时刻起开始的动作」，不说「之后没有明细」；合计满了（`capped_at`）也一样。
 *
 * 「失败的动作除外」只对 `name_limit` 的名称成立（只超过每种名称的上限，失败的动作仍有明细，直到合计满）；
 * `total_limit` 的名称，失败的动作也没有明细。全是 `name_limit` 时写在开头的那一句里；两种都有时开头不写，
 * 写在 `name_limit` 的名称后面；全是 `total_limit` 时不写。
 */
function CapNote({
	countOnly,
	totalFullAt,
	otherDay,
}: {
	countOnly: readonly CountOnlyPeriod[];
	/** 合计的明细满了（`capped_at`）：第一个因此没有明细的动作开始的时刻；没满为 null。 */
	totalFullAt: string | null;
	otherDay: boolean;
}) {
	const clock = (iso: string) => (otherDay ? formatFullDateTime(iso) : formatClock(iso));
	const hasNameLimit = countOnly.some((c) => c.reason === "name_limit");
	const hasTotalLimit = countOnly.some((c) => c.reason === "total_limit");
	return (
		<div data-testid="action-cap-note" className="mt-1.5 text-xs leading-4.5 text-fg-2">
			{countOnly.length > 0 && (
				<>
					<p className="m-0">
						明细有上限：超过以后开始的动作{NODE_ACTIONS.countOnlyNoDetail}
						{hasNameLimit && !hasTotalLimit && EXCEPT_FAILED}，总数、失败数和{FAILURES_LABEL}
						仍然准确。
					</p>
					<ul className="m-0 my-1 list-none p-0 text-fg-1">
						{countOnly.map((c) => (
							<li key={c.name} className="min-w-0 wrap-anywhere">
								「<UntrustedText text={c.name} />
								」从 <span className="font-mono">{clock(c.from)}</span> 起{NODE_ACTIONS.countOnly}
								{hasNameLimit && hasTotalLimit && c.reason === "name_limit" && EXCEPT_FAILED}
							</li>
						))}
					</ul>
				</>
			)}
			{totalFullAt !== null && (
				<p className="m-0">
					全部名称合计的明细已满，满了以后开始的动作都{NODE_ACTIONS.countOnly}
					（失败的也一样）；第一个因此没有明细的动作是{" "}
					<span className="font-mono">{clock(totalFullAt)}</span> 开始的。
				</p>
			)}
			<p className="m-0 mt-1">{NODE_ACTIONS.controlPlaneDropped}</p>
			<p className="m-0 mt-1">
				高频的动作适合按批记录，写法见开发文档「
				<DocPageLink page={GUIDE.page} />
				」的「{GUIDE.section}」。
			</p>
		</div>
	);
}
