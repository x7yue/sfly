import { cn } from "cn";
import {
	ArrowDownIcon,
	ChevronRightIcon,
	FilePenIcon,
	FilePlusIcon,
	FileTextIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Elapsed } from "#/components/elapsed";
import { StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { terminalOutputText } from "#/lib/terminal-text";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Button } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { DiffBlock } from "./DiffBlock";
import { resultDisplayText, toolResultSummary, toolRowTitle } from "./session-text";
import type { TimelineItem, ToolResultInfo } from "./timeline";
import { useFollowEnd } from "./use-follow-end";
import { ROW_KEY_ATTRIBUTE } from "./use-timeline-scroll";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/** 工具调用那一行最前面的图标：命令、读、写、改各一个；只有结果、没有对上的调用（翻页边界）按结果里的线索认。 */
function ToolIcon({ item }: { item: ToolItem }) {
	const kind =
		item.tool ??
		(item.result?.exitCode !== undefined
			? "command"
			: item.result?.diff !== undefined
				? "edit"
				: null);
	const className = "size-3.5 flex-none text-fg-3";
	switch (kind) {
		case "command":
			return <TerminalIcon aria-hidden className={className} />;
		case "read":
			return <FileTextIcon aria-hidden className={className} />;
		case "write":
			return <FilePlusIcon aria-hidden className={className} />;
		case "edit":
			return <FilePenIcon aria-hidden className={className} />;
		case null:
			return <WrenchIcon aria-hidden className={className} />;
	}
}

/**
 * 一个工具调用（#550 定稿）：一行——图标、标题（`$ <命令>`，或「读 / 写 / 改 <路径>」）、状态；默认折叠，**每一行都能展开**。
 *
 * - **状态**：在做时转圈、写已用时；结束后写退出码和用时；出错的整行带红色描边、状态写「出错」；结果太长、只显示了一部分的写明；
 *   一轮有了结局、这个调用一直没有结果（被停止、到了上限、中断）写「已中止」。同时有别的调用在做（模型一次发出了好几个）的标「并行」：
 *   事件的先后是调用开始的先后，先出结果的不一定是先开始的，标记让人看得出它们是同时跑的。
 * - **展开**：先写完整的命令（标题一行放不下时被截断，悬停或聚焦也给全文）；命令还在跑时是**实时的输出**，停在底部，往上翻看
 *   之后不再自动滚到底（不抢滚动），出现新输出时给一个「回到最新输出」；结束后是结果正文，**编辑显示差异**（增的行绿、删的行红）。
 * - **命令的输出显示前先整理**（`resultDisplayText`、`terminalOutputText`）：终端的颜色码、光标移动这些整段序列去掉，连续的空行压成一个；
 *   只改显示，接口里、库里存的是原文（页面上选中复制得到的是整理后的文字）。读、写、改文件的结果显示原文。
 *   其余的控制字符（响铃、退格……）由不可信文字组件写成可见的占位。
 * - **只有结果、没有对上的调用**（会话超过一页，调用在更早的一页里）：标题写明是哪一次调用的结果（`toolRowTitle`），加载更早的内容之后和调用合上。
 */
export function ToolRow({ item, hasMore }: { item: ToolItem; hasMore: boolean }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const { result } = item;
	const running = result === null && !item.abandoned;
	const line = toolRowTitle(item, hasMore);
	const failed = result?.isError === true;
	return (
		<li
			{...{ [ROW_KEY_ATTRIBUTE]: item.key }}
			data-testid="tool-row"
			data-call={item.callId}
			data-state={running ? "running" : failed ? "error" : result ? "done" : "abandoned"}
			data-parallel={item.parallel || undefined}
			// overflow-hidden：展开的正文块的底色不盖住外框的下圆角。
			className={cn(
				"overflow-hidden rounded-lg border bg-surface",
				failed ? "border-danger-line" : running ? "border-signal-line" : "border-border-soft",
			)}
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
				<ToolIcon item={item} />
				<Truncate untrusted className="flex-1 font-mono text-fg-1">
					{line}
				</Truncate>
				{item.parallel && (
					<span
						data-testid="tool-parallel"
						title={SESSION.tool.parallelTitle}
						className="flex-none rounded-sm bg-raised px-1.5 py-px text-fg-2"
					>
						{SESSION.tool.parallel}
					</span>
				)}
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
							failed ? "font-medium text-danger-fg" : "text-fg-3",
						)}
					>
						{failed && <StatusDot kind="failed" />}
						{toolResultSummary(result)}
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
					{item.tool !== null && (
						<pre
							data-testid="tool-command"
							className="m-0 px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-fg-1"
						>
							<UntrustedText text={line} mode="text" />
						</pre>
					)}
					{running && <LiveOutput output={item.output} />}
					{result && <ToolResult tool={item.tool} result={result} />}
				</div>
			)}
		</li>
	);
}

/** 输出的一块：等宽、可滚动，最高 20rem。 */
const OUTPUT_BLOCK =
	"m-0 max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap";

/**
 * 命令还在跑时的实时输出：只留最后一段（`ToolItem.output`，上限 16 KB）。停在底部；往上翻看之后不再替他滚，
 * 新输出到了写一个「回到最新输出」。还没有输出时写一句，免得展开看见一块空白、以为坏了。
 */
function LiveOutput({ output }: { output: string }) {
	// 每段增量都整段重算：`terminalOutputText` 是线性的（`terminal-text.test.ts` 的病态输入），16 KB 是毫秒以内。
	const text = useMemo(() => terminalOutputText(output), [output]);
	// 跟随的信号是输出本身，不是它的长度：输出只留最后 16 KB，过了上限长度恒定、内容却在变（审查 #762）。
	const { ref, behind, toEnd } = useFollowEnd<HTMLPreElement>(output);
	return (
		<section aria-label={SESSION.tool.outputLive} className="relative border-t border-border-soft">
			<h4 className="m-0 flex items-center gap-2 px-3 pt-2 text-xs font-normal text-fg-3">
				<StatusDot kind="running" pulse />
				{SESSION.tool.outputLive}
				{output !== "" && <span>· {SESSION.tool.outputTail}</span>}
			</h4>
			{text === "" ? (
				<p data-testid="tool-live-empty" className="m-0 px-3 py-2 text-xs text-fg-3">
					{SESSION.tool.outputWaiting}
				</p>
			) : (
				<pre ref={ref} data-testid="tool-output" className={cn(OUTPUT_BLOCK, "text-fg-2")}>
					<UntrustedText text={text} mode="text" />
				</pre>
			)}
			{behind && (
				<Button
					size="sm"
					className="absolute right-3 bottom-2 shadow-float"
					data-testid="tool-live-follow"
					onClick={toEnd}
				>
					<ArrowDownIcon aria-hidden />
					{SESSION.tool.followOutput}
				</Button>
			)}
		</section>
	);
}

/**
 * 结果：编辑先是差异（增的行绿、删的行红），再是结果的那句话；别的是结果正文。结果太长、只显示了一部分的在下面写明。
 * 文字是工具输出的原样（命令的输出、文件的内容）：命令的先整理（去控制序列、压空行），文件的原样，都经不可信文字组件显示。
 */
function ToolResult({ tool, result }: { tool: ToolItem["tool"]; result: ToolResultInfo }) {
	const text = resultDisplayText(tool, result);
	const isEdit = result.diff !== undefined;
	return (
		<>
			{result.diff !== undefined && (
				<section aria-label={SESSION.tool.diffHeading} className="border-t border-border-soft">
					<DiffBlock diff={result.diff} testId="tool-diff" className="max-h-80" />
				</section>
			)}
			{/* 编辑的结果那句话（「已替换」）放在差异下面；没有话时不画空块。 */}
			{(!isEdit || text !== "") && (
				<pre
					data-testid="tool-result"
					data-tool={tool ?? undefined}
					className={cn(
						OUTPUT_BLOCK,
						"border-t border-border-soft",
						result.isError ? "text-danger-fg" : "text-fg-2",
					)}
				>
					{text === "" ? SESSION.tool.noOutput : <UntrustedText text={text} mode="text" />}
				</pre>
			)}
			{result.truncated && (
				<p
					data-testid="tool-truncated"
					className="m-0 border-t border-border-soft px-3 py-2 text-xs text-fg-3"
				>
					{SESSION.tool.truncated}
				</p>
			)}
		</>
	);
}
