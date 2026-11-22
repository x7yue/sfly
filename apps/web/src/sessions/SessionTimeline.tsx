import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";
import { Elapsed } from "#/components/elapsed";
import { StatusDot } from "#/components/status";
import { SESSION } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { toolLine, toolResultSummary, turnEndText, turnEndTone } from "./session-text";
import type { TimelineItem, TimelineState } from "./timeline";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/**
 * 会话的时间线（#542，只认平台的会话事件）：用户的话、助手逐字出现的话、每个工具调用一行（默认折叠，展开看结果正文）、
 * 灰字的提示、一轮结束的分隔行；模型在思考时显示「思考中」。这一版是最薄的样式，统一的样式在 #550。
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
							{SESSION.page.loadOlderFailed}：{olderError.message}
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
			return (
				<li
					data-testid="user-message"
					className="rounded-lg border border-border-soft bg-raised px-3 py-2 text-sm whitespace-pre-wrap text-fg-1"
				>
					<span className="text-fg-3">{item.author}：</span>
					<span>{item.text}</span>
				</li>
			);
		case "assistant":
			return (
				<li
					data-testid="assistant-message"
					data-streaming={item.streaming || undefined}
					className="px-1 text-sm leading-relaxed whitespace-pre-wrap text-fg-1"
				>
					{item.text}
				</li>
			);
		case "tool":
			return <ToolRow item={item} />;
		case "notice":
			return (
				<li data-testid="notice" data-kind={item.noticeKind} className="px-1 text-xs text-fg-3">
					{item.message}
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
						{turnEndText(item)}
					</span>
					<span aria-hidden className="h-px flex-1 bg-border-soft" />
				</li>
			);
		}
	}
}

/**
 * 一个工具调用：一行，转圈和已用时，结果到了补上摘要（命令的退出码、用时，出错标红，结果太长写明只显示了头尾）；
 * 默认折叠，结果到了才能展开看正文（这一版结果出来时一次显示，命令输出的实时滚动在 #550）。
 */
function ToolRow({ item }: { item: ToolItem }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const { result } = item;
	const running = result === null && !item.abandoned;
	return (
		<li
			data-testid="tool-row"
			data-call={item.callId}
			data-state={running ? "running" : result?.isError ? "error" : result ? "done" : "abandoned"}
			className="rounded-lg border border-border-soft bg-surface"
		>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				disabled={result === null}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs enabled:cursor-pointer enabled:hover:bg-raised"
			>
				<ChevronRightIcon
					aria-hidden
					className="size-3.5 flex-none text-fg-3 transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
					style={{ rotate: open ? "90deg" : "0deg" }}
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-fg-1">
					{toolLine(item.tool, item.title)}
				</span>
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
					<span className="flex-none text-fg-3">{SESSION.tool.abandoned}</span>
				)}
			</button>
			{open && result && (
				<pre
					id={bodyId}
					data-testid="tool-result"
					className={cn(
						"m-0 max-h-80 overflow-auto border-t border-border-soft bg-sunk px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap",
						result.isError ? "text-danger-fg" : "text-fg-2",
					)}
				>
					{result.text === "" ? SESSION.tool.noOutput : result.text}
				</pre>
			)}
		</li>
	);
}
