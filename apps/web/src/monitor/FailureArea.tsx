import type { RunView } from "@sfly/schema";
import { ChevronRightIcon, OctagonXIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { NodeNameInline, runNodeName } from "#/components/node-name";
import { StatusDot } from "#/components/status";
import { attemptLabel, FAILURE_AREA, moreLabel } from "#/lib/copy";
import { formatClock } from "#/lib/format";
import { Button } from "@/components/ui/button";
import type { OverviewTarget } from "./Overview";
import { allRunFailures, failureSummary, type RunFailure } from "./run-model";

/** 另有几个节点也失败了：最多列出这么多个，其余写「还有 N 个」。 */
const MAX_OTHER_FAILURES = 3;

/** 一个失败的节点写成一段文字：别的子流程实例里的节点前面写子流程实例（同一个节点在几个实例里都失败时分得开）。 */
const failureLabel = (failure: RunFailure): string =>
	`${failure.chain ? `${failure.chain} / ` : ""}${runNodeName(failure.node)}`;

const targetOf = (failure: RunFailure, tab?: OverviewTarget["tab"]): OverviewTarget => ({
	chainInstanceId: failure.ref.chainInstanceId,
	nodeId: failure.ref.nodeId,
	...(tab ? { tab } : {}),
});

/** 「显示名称（节点 ID）」，整段可以折行、不截断；别的子流程实例里的节点前面写子流程实例。 */
function FullNodeName({
	failure,
	withChain = false,
}: {
	failure: RunFailure;
	withChain?: boolean;
}) {
	return (
		<span className="wrap-anywhere">
			{withChain && failure.chain && `${failure.chain} / `}
			<NodeNameInline node={failure.node} />
		</span>
	);
}

/**
 * 概览首屏的失败区域（PRODUCT 第一条：为什么失败任何时候都要一眼可见）：运行里已有节点最终失败时（失败的运行，
 * 或者运行还在进行）出现在链路上面，写出第一个失败的节点（GLOSSARY「第一个失败的节点」）、第几次尝试、失败时间、
 * 失败原因的一行（`errorHeadline`，完整显示、放不下就折行，超过 4 行的收起：一行摘要几乎总是一行，一个几千字的单行不该把链路挤出首屏，全文在「展开全文」里）和一步直达它的尝试、日志的按钮；
 * 错误信息的全文（含堆栈）、被收起的原因收在「展开全文」里，展开才看。
 *
 * 怎么成为首屏最突出的内容：位置在最上面；是概览里唯一铺着色底（`danger-soft`）和描边（`danger-line`）的块；
 * 节点名 `text-lg` 加粗，和关注项读数的最新值同属最大一档，比各区块的标题（`text-base`）都大，原因 `text-base`；形状（八边形、菱形）
 * 和文字「失败」同时表达，强制颜色模式下色底没有了，描边、形状和文字仍在。按钮是中性的：白色主操作留给「再次运行」。
 * 还有别的节点失败时，在下面按失败的先后列出（点一下去它的尝试）。
 */
export function FailureArea({
	run,
	onOpen,
}: {
	run: RunView;
	onOpen: (target: OverviewTarget) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const fullId = useId();
	const headingId = useId();
	const [first, ...others] = allRunFailures(run);
	const reasonRef = useRef<HTMLParagraphElement>(null);
	const [clamped, setClamped] = useState(false);
	const reason = first?.message ?? "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: ResizeObserver 只在尺寸变化时回调，文字变了要重新量
	useLayoutEffect(() => {
		const element = reasonRef.current;
		if (!element) return;
		const check = () => setClamped(element.scrollHeight > element.clientHeight + 1);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(element);
		return () => observer.disconnect();
	}, [reason]);
	if (!first) return null;
	const title =
		run.status === "failed"
			? FAILURE_AREA.title.failed
			: run.status === "running"
				? FAILURE_AREA.title.running
				: FAILURE_AREA.title.ended;
	const node = runNodeName(first.node);
	const hasFull = first.detail !== "" && first.detail !== first.message;
	// 展开看的全文：有堆栈等更多内容时是错误信息的全文，只是原因一行太长时就是这一行。
	const expandable = hasFull || clamped;
	const fullText = hasFull ? first.detail : first.message;
	return (
		<section
			aria-labelledby={headingId}
			data-testid="failure-area"
			className="flex flex-col gap-2.5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3.5"
		>
			<div className="flex items-center gap-2 text-sm font-semibold text-danger-fg">
				<OctagonXIcon aria-hidden className="size-4 flex-none" />
				<h2 id={headingId} className="m-0 text-sm font-semibold">
					{title}
				</h2>
				{first.endedAt && (
					<span className="ml-auto font-mono text-xs font-normal whitespace-nowrap text-fg-2">
						{FAILURE_AREA.failedAt(formatClock(first.endedAt))}
					</span>
				)}
			</div>
			<p
				data-testid="failure-node"
				className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-lg font-semibold text-fg-1"
			>
				<span className="flex items-baseline gap-2">
					<StatusDot kind="failed" className="self-center" />
					<FullNodeName failure={first} />
				</span>
				{first.attempt !== null && (
					<span className="text-sm font-normal text-fg-2">{attemptLabel(first.attempt)}</span>
				)}
				{first.chain && <span className="text-sm font-normal text-fg-3">{first.chain}</span>}
			</p>
			{first.message && (
				<p
					ref={reasonRef}
					data-testid="failure-reason"
					data-clamped={clamped || undefined}
					// 最多 4 行（见上）：更长的在末尾省略，全文在「展开全文」里。
					className="m-0 line-clamp-4 max-w-full text-base text-pretty wrap-anywhere text-fg-1"
				>
					{first.message}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" onClick={() => onOpen(targetOf(first, "attempts"))}>
					{FAILURE_AREA.viewAttempts(node)}
				</Button>
				<Button size="sm" onClick={() => onOpen(targetOf(first, "logs"))}>
					{FAILURE_AREA.viewLogs(node)}
				</Button>
				{expandable && (
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={expanded}
						aria-controls={expanded ? fullId : undefined}
						onClick={() => setExpanded((open) => !open)}
					>
						<ChevronRightIcon
							className="transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
							style={{ rotate: expanded ? "90deg" : "0deg" }}
						/>
						{FAILURE_AREA.fullMessage}
					</Button>
				)}
			</div>
			{expandable && expanded && (
				<pre
					id={fullId}
					data-testid="failure-full"
					className="m-0 max-h-80 overflow-auto rounded-md border border-border-soft bg-inset p-3 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-fg-1"
				>
					{fullText}
				</pre>
			)}
			{others.length > 0 && <OtherFailures failures={others} onOpen={onOpen} />}
		</section>
	);
}

/**
 * 运行还在进行时新出现的节点失败：运行状态没有变，顶栏的状态播报不会读出来。这个播报区域一直挂在概览里（先于失败出现，
 * 读屏才会读它里面后来写进去的字），第一个失败的节点出现时礼貌地读一句；运行已经结束时由顶栏的状态播报（「失败」）。
 */
export function FailureAnnouncer({ run }: { run: RunView }) {
	const [first] = allRunFailures(run);
	const text =
		run.status === "running" && first
			? `${FAILURE_AREA.title.running}：${failureSummary(first)}`
			: "";
	return (
		<output aria-live="polite" className="sr-only">
			{text}
		</output>
	);
}

/** 另有别的节点失败：按失败的先后列出，点一下去它的尝试；列不下的写「还有 N 个」。 */
function OtherFailures({
	failures,
	onOpen,
}: {
	failures: RunFailure[];
	onOpen: (target: OverviewTarget) => void;
}) {
	const shown = failures.slice(0, MAX_OTHER_FAILURES);
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-danger-line pt-2.5 text-xs text-fg-2">
			<span>{FAILURE_AREA.others(failures.length)}</span>
			<ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
				{shown.map((failure) => (
					<li key={`${failure.ref.chainInstanceId}/${failure.ref.nodeId}`}>
						<Button
							variant="link"
							className="text-xs"
							aria-label={FAILURE_AREA.viewAttempts(failureLabel(failure))}
							onClick={() => onOpen(targetOf(failure, "attempts"))}
						>
							<FullNodeName failure={failure} withChain />
						</Button>
					</li>
				))}
			</ul>
			{failures.length > shown.length && <span>{moreLabel(failures.length - shown.length)}</span>}
		</div>
	);
}
