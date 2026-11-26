import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";
import { Elapsed } from "#/components/elapsed";
import { ErrorMessage } from "#/components/feedback/error-message";
import { StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Button } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { CommitRow } from "./CommitRow";
import { RecordRow } from "./RecordRow";
import {
	steerDeliveryLabel,
	toolLine,
	toolResultSummary,
	turnEndText,
	turnEndTone,
	userRoleLabel,
} from "./session-text";
import type { TimelineItem, TimelineState } from "./timeline";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type UserItem = Extract<TimelineItem, { kind: "user" }>;

/**
 * 会话的时间线（#542，只认平台的会话事件）：用户的话、助手逐字出现的话、每个工具调用一行（默认折叠，展开看结果正文）、
 * 灰字的提示、一轮结束的分隔行、会话结束的一行；模型在思考时显示「思考中」。在做时说的话标「插话」，写着送到了没有（等待送达、已送到、
 * 没有送到）；停止途中说的、排在这一轮后面的话标「排在这一轮后面」，被撤掉的标「已撤掉」。这一版是最薄的样式，统一的样式在 #550。
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
	return (
		<div className="flex flex-col gap-3">
			{state.hasMore && (
				<div className="flex items-center gap-3">
					<Button size="sm" variant="ghost" disabled={loadingOlder} onClick={onLoadOlder}>
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
				className="m-0 flex list-none flex-col gap-3 p-0"
			>
				{state.items.map((item) => (
					<TimelineRow key={item.key} item={item} />
				))}
				{state.thinking && (
					<li data-testid="thinking" className="flex items-center gap-2 text-sm text-fg-3">
						<StatusDot kind="running" pulse />
						<output>{SESSION.page.thinking}</output>
					</li>
				)}
			</ol>
		</div>
	);
}

function TimelineRow({ item }: { item: TimelineItem }) {
	switch (item.kind) {
		case "user":
			return <UserRow item={item} />;
		case "assistant":
			return (
				<li
					data-testid="assistant-message"
					data-streaming={item.streaming || undefined}
					className="px-1 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-fg-1"
				>
					<UntrustedText text={item.text} mode="text" />
				</li>
			);
		case "tool":
			return <ToolRow item={item} />;
		case "commit":
			return <CommitRow item={item} />;
		case "run":
		case "version":
			return <RecordRow item={item} />;
		case "notice":
			return (
				<li
					data-testid="notice"
					data-kind={item.noticeKind}
					className="px-1 text-xs wrap-anywhere text-fg-3"
				>
					{/* 通知里可能引用了用户的话（`steer_dropped`）：别人写的文字。 */}
					<UntrustedText text={item.message} />
				</li>
			);
		case "session_ended":
			return (
				<li data-testid="session-ended" className="flex items-center gap-3 py-1 text-xs text-fg-2">
					<span aria-hidden className="h-px flex-1 bg-border-soft" />
					<span>
						{SESSION.sessionEnded.prefix}
						<UntrustedText text={item.by} />
						{SESSION.sessionEnded.suffix}
					</span>
					<span aria-hidden className="h-px flex-1 bg-border-soft" />
				</li>
			);
		case "turn_end": {
			const tone = turnEndTone(item.outcome);
			return (
				<li
					data-testid="turn-end"
					data-outcome={item.outcome}
					className="flex items-center gap-3 py-1 text-xs"
				>
					<span aria-hidden className="h-px flex-1 bg-border-soft" />
					<span
						className={cn(
							"text-fg-2",
							tone === "warn" && "text-warn-fg",
							tone === "danger" && "text-danger-fg",
						)}
					>
						<UntrustedText text={turnEndText(item)} />
					</span>
					<span aria-hidden className="h-px flex-1 bg-border-soft" />
				</li>
			);
		}
	}
}

/**
 * 用户的一句话：作者和文字；插话、排在这一轮后面的话、被撤掉的话下面一行小字写明是哪一种，插话再写送到了没有。
 * 开一轮的话没有这一行（和以前一样）。送到了没有的状态由 `timeline.ts` 的纯函数算出，这里只显示。
 */
function UserRow({ item }: { item: UserItem }) {
	const role = userRoleLabel(item.role);
	const delivery = item.role === "steer" ? steerDeliveryLabel(item.delivery) : null;
	return (
		<li
			data-testid="user-message"
			data-role={item.role}
			data-delivery={item.role === "steer" ? (item.delivery ?? undefined) : undefined}
			className={cn(
				"rounded-lg border border-border-soft bg-raised px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap text-fg-1",
				item.role === "cancelled" && "text-fg-3",
			)}
		>
			{/* 撤掉的话划删除线只划话本身：父元素的删除线盖不住（`no-underline` 取消不了），标记「已撤掉」不能被划掉。 */}
			<span className={cn("text-fg-3", item.role === "cancelled" && "line-through")}>
				<UntrustedText text={item.author} />：
			</span>
			<span className={cn(item.role === "cancelled" && "line-through")}>
				<UntrustedText text={item.text} mode="text" />
			</span>
			{role !== null && (
				<span className="mt-1 flex items-center gap-2 text-xs whitespace-normal text-fg-3">
					<span data-testid="message-role" className="font-medium">
						{role}
					</span>
					{delivery !== null && (
						<span
							data-testid="message-delivery"
							className={cn(
								"flex items-center gap-1.5",
								item.delivery === "dropped" && "font-medium text-warn-fg",
							)}
						>
							<StatusDot
								kind={
									item.delivery === "waiting"
										? "queued"
										: item.delivery === "dropped"
											? "warn"
											: "ok"
								}
							/>
							{delivery}
						</span>
					)}
				</span>
			)}
		</li>
	);
}

/**
 * 一个工具调用：一行，转圈和已用时，结果到了补上摘要（命令的退出码、用时，出错标红，结果太长写明输出太长、只显示了头尾）；
 * 默认折叠，**每一行都能展开**：展开后先写完整的命令（标题一行放不下时被截断，悬停或聚焦也给全文；在做和已中止的行没有结果，
 * 展开就是看这条命令），有结果的再接结果正文（这一版结果出来时一次显示，命令输出的实时滚动在 #550）。
 * 「已中止」（这一轮有了结局、这个调用一直没有结果）和结果的摘要不是一种灰字：带一个「已停止」形状的点，文字是正文色。
 */
function ToolRow({ item }: { item: ToolItem }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const { result } = item;
	const running = result === null && !item.abandoned;
	const line = toolLine(item.tool, item.title);
	return (
		<li
			data-testid="tool-row"
			data-call={item.callId}
			data-state={running ? "running" : result?.isError ? "error" : result ? "done" : "abandoned"}
			// overflow-hidden：展开的正文块的底色不盖住外框的下圆角。
			className="overflow-hidden rounded-lg border border-border-soft bg-surface"
		>
			<Truncate
				label={untrustedPlain(line, "text")}
				render={
					<button
						type="button"
						aria-expanded={open}
						aria-controls={open ? bodyId : undefined}
						onClick={() => setOpen((v) => !v)}
						className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-raised"
					/>
				}
			>
				<ChevronRightIcon
					aria-hidden
					className="size-3.5 flex-none text-fg-3 transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
					style={{ rotate: open ? "90deg" : "0deg" }}
				/>
				<Truncate untrusted className="flex-1 font-mono text-fg-1">
					{line}
				</Truncate>
				{running ? (
					<span className="flex flex-none items-center gap-1.5 text-fg-3">
						<StatusDot kind="running" pulse />
						{SESSION.tool.running}
						{item.at !== null && <Elapsed since={Date.parse(item.at)} className="font-mono" />}
					</span>
				) : result ? (
					<span
						className={cn(
							"flex flex-none items-center gap-1.5",
							result.isError ? "text-danger-fg" : "text-fg-3",
						)}
					>
						{result.isError && <StatusDot kind="failed" />}
						{toolResultSummary(item.tool, result)}
					</span>
				) : (
					<span
						data-testid="tool-abandoned"
						className="flex flex-none items-center gap-1.5 font-medium text-fg-1"
					>
						<StatusDot kind="stopped" />
						{SESSION.tool.abandoned}
					</span>
				)}
			</Truncate>
			{open && (
				<div id={bodyId} className="border-t border-border-soft bg-sunk">
					<pre
						data-testid="tool-command"
						className="m-0 px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-fg-1"
					>
						<UntrustedText text={line} mode="text" />
					</pre>
					{result && (
						<pre
							data-testid="tool-result"
							className={cn(
								"m-0 max-h-80 overflow-auto border-t border-border-soft px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap",
								result.isError ? "text-danger-fg" : "text-fg-2",
							)}
						>
							{result.text === "" ? (
								SESSION.tool.noOutput
							) : (
								<UntrustedText text={result.text} mode="text" />
							)}
						</pre>
					)}
				</div>
			)}
		</li>
	);
}
