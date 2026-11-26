import { cn } from "cn";
import {
	ArrowDownIcon,
	CircleSlashIcon,
	HistoryIcon,
	InfoIcon,
	OctagonAlertIcon,
	RotateCwIcon,
	ShrinkIcon,
	TriangleAlertIcon,
	UnplugIcon,
} from "lucide-react";
import { memo } from "react";
import { Elapsed } from "#/components/elapsed";
import { ErrorMessage } from "#/components/feedback/error-message";
import { StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { formatClock, formatFullDateTime } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { CommitRow } from "./CommitRow";
import { RecordRow } from "./RecordRow";
import { steerDeliveryLabel, turnEndText, turnEndTone, userRoleLabel } from "./session-text";
import { ToolRow } from "./ToolRow";
import { modelActivity, type TimelineItem, type TimelineState } from "./timeline";
import { ROW_KEY_ATTRIBUTE, useTimelineScroll } from "./use-timeline-scroll";

type UserItem = Extract<TimelineItem, { kind: "user" }>;
type NoticeItem = Extract<TimelineItem, { kind: "notice" }>;
type TurnEndItem = Extract<TimelineItem, { kind: "turn_end" }>;

/** 这一行在时间线上的位置标记：往前翻页时靠它认出刚才看着的那一行（`use-timeline-scroll.ts`）。 */
const rowKey = (key: string) => ({ [ROW_KEY_ATTRIBUTE]: key });

/**
 * 会话的时间线（#542，定稿 #550；只认平台的会话事件）：
 *
 * | 条目 | 样子 |
 * |---|---|
 * | 用户的话 | 发起人的名字、时间；插话标「插话」并写送到了没有；停止途中说的话标「排在这一轮后面」，被撤掉的标「已撤掉」 |
 * | 助手的话 | 没有外框，Markdown 渲染（`AssistantMarkdown`），逐字出现；等模型时写「思考中」或「等模型回复」和已等了多久 |
 * | 工具调用 | 一行，默认折叠，展开看命令、实时输出、结果、差异（`ToolRow`） |
 * | 平台记录 | 左边一条竖线和「平台记录」的标签：提交、场景版本、运行（`PlatformRecord`） |
 * | 提示 | 一行灰字带小图标：重试、压缩上下文、插话没有送到、排队的话被撤掉、过程没有记下、换成了摘要 |
 * | 一轮的结束 | 一行分隔：结局、步数、用时；到了上限是提醒，中断、出错、模型不可用是醒目的一块，写明原因和「做过的步骤都在上面」 |
 * | 会话已结束 | 一行分隔，之后没有输入框 |
 *
 * **滚动**（`useTimelineScroll`）：自己是滚动区域（页头和输入框不跟着滚）；进入页面滚到最新；人在底部时跟着滚，往上翻看之后不替他滚，
 * 显示「有新内容」；往前翻页保持位置。行是 `memo`：一条事件到了只有变了的那一行重新渲染，几百行的会话里逐字出现的话不会每个字
 * 重排所有的行。
 */
export function SessionTimeline({
	state,
	onLoadOlder,
	loadingOlder,
	olderError,
}: {
	state: TimelineState;
	onLoadOlder: () => void;
	loadingOlder: boolean;
	olderError: Error | null;
}) {
	const last = state.items.at(-1);
	const activity = modelActivity(state);
	const { scroller, hasNew, scrollToBottom, captureAnchor } = useTimelineScroll({
		head: state.items[0]?.key ?? null,
		// 最后一行变了（新来一行、逐字出现的话变长、命令的输出变长、结果到了）或者进行中的提示出现、消失：底下有新内容。
		tail: `${state.items.length}:${last?.key ?? ""}:${tailSize(last)}:${activity?.kind ?? ""}`,
	});
	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<section
				ref={scroller}
				data-testid="session-scroll"
				// 键盘用户要能用方向键和翻页键滚它。
				// biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的区域要能聚焦，键盘才滚得动
				tabIndex={0}
				aria-label={SESSION.page.scrollRegion}
				className="relative min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
			>
				<div className="flex flex-col gap-2.5 pb-3">
					{state.hasMore && (
						<div className="flex items-center gap-3">
							<Button
								size="sm"
								variant="ghost"
								disabled={loadingOlder}
								onClick={() => {
									// 更早的一页放到最前面之后，要把现在看着的那一行放回原来的位置：趁现在量。
									captureAnchor();
									onLoadOlder();
								}}
							>
								{loadingOlder ? SESSION.page.loadingOlder : SESSION.page.loadOlder}
							</Button>
							{olderError && (
								<span role="alert" className="text-xs text-danger-fg">
									{SESSION.page.loadOlderFailed}：<ErrorMessage error={olderError} />
								</span>
							)}
						</div>
					)}
					<ol
						aria-label={SESSION.page.timeline}
						data-testid="session-timeline"
						className="m-0 flex list-none flex-col gap-2.5 p-0"
					>
						{state.items.map((item) => (
							<TimelineRow key={item.key} item={item} hasMore={state.hasMore} />
						))}
						{activity !== null && (
							<li
								data-testid={activity.kind === "thinking" ? "thinking" : "waiting-model"}
								className="flex items-center gap-2 px-1 text-sm text-fg-3"
							>
								<StatusDot kind="running" pulse />
								<output>
									{activity.kind === "thinking" ? SESSION.page.thinking : SESSION.page.waiting}
								</output>
								{activity.kind === "waiting" && activity.since !== null && (
									<Elapsed since={Date.parse(activity.since)} className="font-mono text-xs" />
								)}
							</li>
						)}
					</ol>
				</div>
			</section>
			{hasNew && (
				<Button
					size="sm"
					data-testid="timeline-new-content"
					title={SESSION.page.newContentTitle}
					className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-float"
					onClick={scrollToBottom}
				>
					<ArrowDownIcon aria-hidden />
					{SESSION.page.newContent}
				</Button>
			)}
		</div>
	);
}

/** 最后一行「多大」：逐字出现的话的长度、命令输出的长度、有没有结果。变了就是底下有新内容。 */
function tailSize(item: TimelineItem | undefined): number {
	if (!item) return 0;
	if (item.kind === "assistant") return item.text.length;
	if (item.kind === "tool") return item.output.length + (item.result ? 1 : 0);
	return 0;
}

/** 一行：`item` 没变就不重新渲染（`applyEvent` 只换变了的那一行）。 */
const TimelineRow = memo(function TimelineRow({
	item,
	hasMore,
}: {
	item: TimelineItem;
	hasMore: boolean;
}) {
	switch (item.kind) {
		case "user":
			return <UserRow item={item} />;
		case "assistant":
			return (
				<li
					{...rowKey(item.key)}
					data-testid="assistant-message"
					data-streaming={item.streaming || undefined}
					className="px-1 text-sm leading-relaxed wrap-anywhere text-fg-1"
				>
					<AssistantMarkdown text={item.text} />
				</li>
			);
		case "tool":
			return <ToolRow item={item} hasMore={hasMore} />;
		case "commit":
			return <CommitRow item={item} />;
		case "run":
		case "version":
			return <RecordRow item={item} />;
		case "notice":
			return <NoticeRow item={item} />;
		case "session_ended":
			return (
				<li
					{...rowKey(item.key)}
					data-testid="session-ended"
					className="flex items-center gap-3 py-2 text-xs text-fg-2"
				>
					<span aria-hidden className="h-px flex-1 bg-border-strong" />
					<span className="flex items-center gap-1.5 font-medium">
						<StatusDot kind="stopped" />
						{SESSION.sessionEnded.prefix}
						<UntrustedText text={item.by} />
						{SESSION.sessionEnded.suffix}
					</span>
					<span aria-hidden className="h-px flex-1 bg-border-strong" />
				</li>
			);
		case "turn_end":
			return <TurnEndRow item={item} />;
	}
});

/** 提示的小图标：每一类一个，颜色都是次要文字色（提示是一行灰字，不抢正文）。 */
const NOTICE_ICON: Record<NoticeItem["noticeKind"], typeof InfoIcon> = {
	retry: RotateCwIcon,
	retry_end: RotateCwIcon,
	compaction: ShrinkIcon,
	steer_dropped: TriangleAlertIcon,
	queue_cancelled: CircleSlashIcon,
	events_lost: UnplugIcon,
	context_reset: HistoryIcon,
};

/** 提示：一行灰字，带小图标；文字是产生它的一方写的一句话（通知里可能引用了用户的话：别人写的文字）。 */
function NoticeRow({ item }: { item: NoticeItem }) {
	const Icon = NOTICE_ICON[item.noticeKind] ?? InfoIcon;
	return (
		<li
			{...rowKey(item.key)}
			data-testid="notice"
			data-kind={item.noticeKind}
			className="flex items-start gap-2 px-1 text-xs text-fg-3"
		>
			<Icon aria-hidden className="mt-0.5 size-3.5 flex-none" />
			<span className="min-w-0 wrap-anywhere">
				{/* 通知里可能引用了用户的话（`steer_dropped`）：别人写的文字。 */}
				<UntrustedText text={item.message} />
			</span>
		</li>
	);
}

/**
 * 一轮的结束：
 * - 完成、已停止：一行分隔，中性；
 * - 到了上限：分隔行，提醒的颜色；
 * - 中断、出错、模型不可用：**醒目的一块**（红色描边和淡底、图标），写明原因；中断和出错再写「这一轮做过的步骤都在上面」（做了几步才写；
 *   一步也没做时没有可看的）——模型不可用的原因句里已经有这一句，不再重复。
 * 文字是 `turnEndText` 的一句（上游给的原因，别人写的文字）；读屏播报用的也是它。
 */
function TurnEndRow({ item }: { item: TurnEndItem }) {
	const tone = turnEndTone(item.outcome);
	if (tone === "danger") {
		const note = (item.outcome === "interrupted" || item.outcome === "failed") && item.steps !== 0;
		return (
			<li
				{...rowKey(item.key)}
				data-testid="turn-end-block"
				className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-xs"
			>
				{/* 结局那一句自己是 `turn-end`（和别的结局一样：文字就是 `turnEndText`）；「做过的步骤都在上面」是它下面的一句说明。 */}
				<div
					data-testid="turn-end"
					data-outcome={item.outcome}
					className="flex items-start gap-2 text-danger-fg"
				>
					<OctagonAlertIcon aria-hidden className="mt-0.5 size-3.5 flex-none" />
					<span className="min-w-0 font-medium wrap-anywhere">
						<UntrustedText text={turnEndText(item)} />
					</span>
				</div>
				{note && (
					<p data-testid="turn-end-note" className="m-0 mt-1 pl-5.5 text-fg-2">
						{SESSION.turnEnd.stepsAbove}
					</p>
				)}
			</li>
		);
	}
	return (
		<li
			{...rowKey(item.key)}
			data-testid="turn-end"
			data-outcome={item.outcome}
			className="flex items-center gap-3 py-1 text-xs"
		>
			<span aria-hidden className="h-px flex-1 bg-border-soft" />
			<span
				className={cn("flex items-center gap-1.5 text-fg-2", tone === "warn" && "text-warn-fg")}
			>
				{tone === "warn" && <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />}
				<UntrustedText text={turnEndText(item)} />
			</span>
			<span aria-hidden className="h-px flex-1 bg-border-soft" />
		</li>
	);
}

/**
 * 用户的一句话：发起人的名字和时间一行，下面是话；插话、排在这一轮后面的话、被撤掉的话在名字那一行后面写明是哪一种，插话再写送到了没有。
 * 开一轮的话没有标记。送到了没有的状态由 `timeline.ts` 的纯函数算出，这里只显示。
 */
function UserRow({ item }: { item: UserItem }) {
	const role = userRoleLabel(item.role);
	const delivery = item.role === "steer" ? steerDeliveryLabel(item.delivery) : null;
	const cancelled = item.role === "cancelled";
	return (
		<li
			{...rowKey(item.key)}
			data-testid="user-message"
			data-role={item.role}
			data-delivery={item.role === "steer" ? (item.delivery ?? undefined) : undefined}
			className={cn(
				"rounded-lg border border-border-soft bg-raised px-3 py-2 text-sm wrap-anywhere text-fg-1",
				cancelled && "text-fg-3",
			)}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs whitespace-normal">
				<span data-testid="message-author" className="font-semibold text-fg-2">
					<UntrustedText text={item.author} />
				</span>
				<time
					dateTime={item.at}
					title={formatFullDateTime(item.at)}
					className="font-mono text-fg-3"
				>
					{formatClock(item.at)}
				</time>
				{role !== null && (
					<span
						data-testid="message-role"
						className="rounded-sm bg-raised-2 px-1.5 py-px font-medium text-fg-2"
					>
						{role}
					</span>
				)}
				{delivery !== null && (
					<span
						data-testid="message-delivery"
						className={cn(
							"flex items-center gap-1.5 text-fg-3",
							item.delivery === "dropped" && "font-medium text-warn-fg",
						)}
					>
						<StatusDot
							kind={
								item.delivery === "waiting" ? "queued" : item.delivery === "dropped" ? "warn" : "ok"
							}
						/>
						{delivery}
					</span>
				)}
			</div>
			{/* 撤掉的话划删除线只划话本身：标记「已撤掉」不能被划掉。 */}
			<p
				data-testid="message-text"
				className={cn("m-0 mt-1 whitespace-pre-wrap", cancelled && "line-through")}
			>
				<UntrustedText text={item.text} mode="text" />
			</p>
		</li>
	);
}
