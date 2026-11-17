import { nodeCardText, nodeDefaultTitle, nodeDisplayName } from "@sfly/orchestration";
import { type NodeProps, Position } from "@xyflow/react";
import { cn } from "cn";
import { type CSSProperties, useCallback, useId, useRef } from "react";
import { NoteIcon } from "#/components/note-icon";
import { StatusDot, type StatusKind, StatusPill } from "#/components/status";
import { BaseHandle } from "@/components/ui/base-handle";
import { BaseNode, BaseNodeHeaderTitle } from "@/components/ui/base-node";
import { type NodeDecoration, useFlowCanvas } from "./context";
import type { SfNode } from "./flow";
import { NODE_HEIGHT, NODE_RADIUS, NODE_WIDTH, PORT_SIZE, PORTS } from "./geometry";
import { NodeTitleEditor } from "./NodeTitleEditor";
import { idParts, KIND_META, nodeSlot, nodeTags } from "./node-display";
import { WarningBadge } from "./WarningBadge";
import { LOD_HIDDEN, ZOOM_TEXT_12, ZOOM_TEXT_TITLE } from "./zoom-text";

const portStyle = (at: { x: number; y: number }, rotate = false): CSSProperties => ({
	left: at.x,
	top: at.y,
	right: "auto",
	bottom: "auto",
	width: PORT_SIZE,
	height: PORT_SIZE,
	transform: `translate(-50%, -50%)${rotate ? " rotate(45deg)" : ""}`,
});

/**
 * 双击标题：原生监听挂在标题上，先于画布的双击缩放（xyflow 的 d3-zoom 监听在更外层）拦下事件。
 * React 的事件委托在根节点上，等它收到时缩放已经发生。`onDoubleClick` 为 undefined（只读画布）时不拦。
 */
function useTitleDoubleClick(onDoubleClick: (() => void) | undefined) {
	const latest = useRef(onDoubleClick);
	latest.current = onDoubleClick;
	return useCallback((el: HTMLElement | null) => {
		if (!el) return;
		const handle = (event: MouseEvent) => {
			if (!latest.current) return;
			event.stopPropagation();
			latest.current();
		};
		el.addEventListener("dblclick", handle);
		return () => el.removeEventListener("dblclick", handle);
	}, []);
}

/**
 * 站点灯的三种样子（DESIGN-SYSTEM §2.3）：要盯的状态（执行中、失败、等待中）是状态色的淡底加描边，看全图时放大；
 * 走完了的（成功、跳过、停止）贴着所在底色，看全图时缩成一个小点；还没轮到的（待执行、排队、取消）只有一圈描边。
 */
const LAMP: Record<StatusKind, { tone: "tall" | "done" | "idle"; color: string; line: string }> = {
	running: { tone: "tall", color: "var(--signal)", line: "var(--signal-line)" },
	failed: { tone: "tall", color: "var(--danger)", line: "var(--danger-line)" },
	warn: { tone: "tall", color: "var(--warn)", line: "var(--warn-line)" },
	ok: { tone: "done", color: "var(--ok)", line: "var(--ok-line)" },
	skipped: { tone: "done", color: "var(--skipped)", line: "var(--border-strong)" },
	stopped: { tone: "done", color: "var(--stopped)", line: "var(--border-strong)" },
	pending: { tone: "idle", color: "var(--pending)", line: "var(--border-strong)" },
	queued: { tone: "idle", color: "var(--pending)", line: "var(--border-strong)" },
	cancelled: { tone: "idle", color: "var(--cancelled)", line: "var(--border-strong)" },
};

/**
 * 卡片左侧的站点灯：编辑时是节点种类的图标，运行时换成状态标记。看全图（data-lod-far）时要盯的状态放大到屏幕上
 * 18px（失败是实心红灯），走完了和还没轮到的缩成屏幕上约 10px 的小点。
 */
function Lamp({
	decoration,
	kindIcon: KindIcon,
}: {
	decoration: NodeDecoration | undefined;
	kindIcon: SfKindIcon;
}) {
	const status = decoration?.run ? decoration.status : undefined;
	const lamp = status ? LAMP[status.kind] : undefined;
	return (
		<span
			aria-hidden
			data-lamp={lamp?.tone ?? "kind"}
			data-lamp-status={status?.kind}
			style={
				lamp ? ({ "--lamp": lamp.color, "--lamp-line": lamp.line } as CSSProperties) : undefined
			}
			className={cn(
				"grid size-8.5 flex-none place-items-center rounded-full bg-raised-2 text-fg-2 shadow-[inset_0_0_0_1px_var(--border-strong)]",
				"[&>svg]:size-4 in-data-[lod-far=true]:size-[max(34px,calc(16px/var(--canvas-zoom)))] in-data-[lod-far=true]:[&>svg]:size-1/2",
				// 要盯的状态。看全图时失败的灯是实心红：只给 --lamp-solid 赋值，不和这里的淡底写同一个属性——
				// 两条规则特异性相同，谁赢取决于样式表里的先后，实心红曾被淡底盖掉。
				"data-[lamp=tall]:bg-[color:var(--lamp-solid,color-mix(in_srgb,var(--lamp)_15%,var(--canvas-node-bg)))] data-[lamp=tall]:shadow-[inset_0_0_0_1.5px_var(--lamp-line)]",
				"data-[lamp=tall]:[&>i]:size-3",
				"in-data-[lod-far=true]:data-[lamp=tall]:size-[max(34px,calc(18px/var(--canvas-zoom)))] in-data-[lod-far=true]:data-[lamp=tall]:shadow-[inset_0_0_0_max(1.5px,calc(2px/var(--canvas-zoom)))_var(--lamp)] in-data-[lod-far=true]:data-[lamp=tall]:[&>i]:size-[42%]",
				"in-data-[lod-far=true]:data-[lamp-status=failed]:[--lamp-solid:var(--danger)] in-data-[lod-far=true]:data-[lamp-status=failed]:[&>i]:text-canvas-bg",
				// 走完了的、还没轮到的
				"data-[lamp=done]:bg-transparent data-[lamp=done]:shadow-[inset_0_0_0_1px_var(--canvas-run-done-border)]",
				"data-[lamp=idle]:bg-transparent",
				"data-[lamp=done]:[&>i]:size-2.5 data-[lamp=idle]:[&>i]:size-2.5",
				"in-data-[lod-far=true]:data-[lamp=done]:size-[max(16px,calc(10px/var(--canvas-zoom)))] in-data-[lod-far=true]:data-[lamp=idle]:size-[max(16px,calc(10px/var(--canvas-zoom)))]",
				"in-data-[lod-far=true]:data-[lamp=done]:shadow-none in-data-[lod-far=true]:data-[lamp=idle]:shadow-none",
				"in-data-[lod-far=true]:data-[lamp=done]:[&>i]:size-full in-data-[lod-far=true]:data-[lamp=idle]:[&>i]:size-full",
			)}
		>
			{status ? <StatusDot kind={status.kind} /> : <KindIcon />}
		</span>
	);
}
type SfKindIcon = (typeof KIND_META)[keyof typeof KIND_META]["icon"];

/**
 * 节点卡片（DESIGN-SYSTEM §2.3「站点胶囊」）：一枚矮胶囊，左边一盏站点灯（编辑时是种类图标，运行时是状态标记），
 * 第一行是标题和右侧的数字（运行时的进度、剩余时间、耗时；编辑时的警告），第二行是节点 ID（放不下时保留结尾）、
 * 原来的标题（有显示名称时）和配置摘要，运行时换成失败原因或主指标；执行中、等待中的底边有一条进度线。
 * 右上角标签（always、另选的 Agent、重试）。端口常显：左侧链入口，右侧链出口，异步任务节点底部的调度出口；
 * 子流程入口节点左侧接收调度连线。叠加的运行状态、主指标、差异标记来自 FlowCanvas 的 decorateNode（见 context.ts）。
 */
export function NodeCard({ id, data, selected }: NodeProps<SfNode>) {
	const { info, ports, grounds, decorateNode, rename } = useFlowCanvas();
	const { node } = data;
	// 只有空白等于没写（保存时就不保存），不画图标。
	const note = node.note?.trim();
	const meta = KIND_META[node.kind];
	const { title, caption } = nodeCardText(node, info);
	const named = nodeDisplayName(node) !== undefined;
	const warnings = info.warnings.get(id) ?? [];
	const decoration = decorateNode?.(id, node);
	const running = decoration?.run !== undefined;
	const ground = grounds.get(id) ?? "canvas";
	const inAnnotation = ground !== "canvas" && ground !== "subflow";
	const sunk =
		decoration?.run === "done" || decoration?.run === "skipped" || decoration?.run === "stopped";
	const port = ports.get(id) ?? { in: false, out: false, dispatch: false };
	const tags = nodeTags(node);
	const slot = nodeSlot(node);
	const ids = idParts(id);
	// 有显示名称时第二行写原来的标题（节点类型、「等待 30s」……），和显示名称相同时不写；
	// 摘要已经写在里面时（等待 30s 的 30s）不再重复。
	const shownCaption = named && caption !== title ? caption : undefined;
	const shownSlot = shownCaption?.includes(slot.text) ? undefined : slot;
	const isStart = node.kind === "entry" || node.kind === "subflow_entry";
	const cardId = useId();
	const statusId = useId();
	const noteId = useId();
	// 子流程入口节点没有显示名称，不进入原地编辑。
	const editing = rename?.active === id && node.kind !== "subflow_entry";
	const titleRef = useTitleDoubleClick(rename ? () => rename.start(id) : undefined);

	return (
		<BaseNode
			// 原地编辑标题时卡片是一组：按钮里不能放输入框。
			role={editing ? "group" : "button"}
			tabIndex={-1}
			// 名称：「节点 ID，种类，标题」（aria-label，由自己的 id 引用）接上右侧的状态（运行状态和数字、警告、差异标记）。
			id={cardId}
			aria-label={[`节点 ${id}`, caption, title !== id && title].filter(Boolean).join("，")}
			aria-labelledby={`${cardId} ${statusId}`}
			// 备注是描述：读屏用户用方向键切到节点时跟在名称后面读到（图标本身不可聚焦，见 NoteIcon）。
			aria-describedby={note ? noteId : undefined}
			aria-pressed={editing ? undefined : selected}
			data-node-id={id}
			data-run={decoration?.run}
			data-mark={decoration?.mark}
			data-ground={ground}
			style={{ width: NODE_WIDTH, height: NODE_HEIGHT, borderRadius: NODE_RADIUS }}
			className={cn(
				"flex items-center gap-3 pr-4 pl-3.25 hover:border-canvas-node-hover",
				"in-data-[lod=true]:gap-2.5 in-data-[lod-far=true]:pl-3",
				"focus-visible:outline-offset-3",
				// 运行状态画在描边上；看全图时要盯的状态描边加粗到屏幕上 2px。
				"data-[run=running]:border-canvas-run-running data-[run=failed]:border-canvas-run-failed data-[run=waiting]:border-warn-line",
				"in-data-[lod-far=true]:data-[run=running]:border-[length:max(1px,calc(2px/var(--canvas-zoom)))] in-data-[lod-far=true]:data-[run=failed]:border-[length:max(1px,calc(2px/var(--canvas-zoom)))] in-data-[lod-far=true]:data-[run=waiting]:border-[length:max(1px,calc(2px/var(--canvas-zoom)))]",
				// 走完了的（成功、跳过、停止）只留轮廓：底色等于所在的底色（画布、注释框底板、子流程区域，tokens.css 的
				// data-ground），一圈屏幕上 1px 的灰描边留住胶囊的形状；退后的状态都不用不透明度，标题换成次要文字色，
				// 文字对比度不降（DESIGN-SYSTEM §2.2）。
				"data-[run=done]:border-canvas-run-done-border data-[run=done]:bg-canvas-run-done-bg data-[run=done]:border-[length:max(1px,calc(1px/var(--canvas-zoom)))]",
				"data-[run=skipped]:border-canvas-run-done-border data-[run=skipped]:bg-canvas-run-done-bg data-[run=skipped]:border-[length:max(1px,calc(1px/var(--canvas-zoom)))] data-[run=skipped]:text-fg-2",
				"data-[run=stopped]:border-canvas-run-done-border data-[run=stopped]:bg-canvas-run-done-bg data-[run=stopped]:border-[length:max(1px,calc(1px/var(--canvas-zoom)))] data-[run=stopped]:text-fg-2",
				"data-[run=pending]:text-fg-2",
				"data-[run=cancelled]:border-dashed data-[run=cancelled]:border-border-control data-[run=cancelled]:text-fg-2",
				"data-[mark=added]:border-ok data-[mark=changed]:border-warn",
				// 选中或悬停注释框时（FlowCanvas 给节点外层加类名）：成员描边加光晕，框里的非成员「下沉」到所在底色、
				// 标题换成次要文字色，和退后的运行状态一样不用不透明度，文字对比度不降。
				"in-[.annotation-member]:border-canvas-node-selected in-[.annotation-member]:shadow-[0_0_0_2px_var(--canvas-node-selected-ring)]",
				"in-[.annotation-dim]:border-canvas-run-done-border in-[.annotation-dim]:bg-canvas-run-done-bg in-[.annotation-dim]:border-[length:max(1px,calc(1px/var(--canvas-zoom)))] in-[.annotation-dim]:text-fg-2",
				"data-[mark=removed]:border-dashed data-[mark=removed]:border-danger data-[mark=removed]:text-fg-2 data-[mark=removed]:[&_[data-slot=base-node-title]]:line-through",
			)}
		>
			{tags.length > 0 && (
				// 标签贴在卡片上边线外面：语义缩放时标签和标题的字都会放大，压进卡片就会盖住标题。
				<div className={cn("absolute right-5 bottom-[calc(100%-1px)] flex gap-1", LOD_HIDDEN)}>
					{tags.map((tag) => (
						<span
							key={tag}
							className={cn(
								"rounded-md border border-border-strong bg-raised-2 px-1.5 leading-[1.4] text-fg-2",
								ZOOM_TEXT_12,
							)}
						>
							{tag}
						</span>
					))}
				</div>
			)}
			<Lamp decoration={decoration} kindIcon={meta.icon} />
			<div
				className={cn(
					"flex min-w-0 flex-1 flex-col gap-0.5",
					// 注释框的底板比卡片亮，下沉后卡片底就是底板，辅助文字（fg-3）在上面只剩约 4.1:1：换成次要文字色
					// （≥ 5.0:1，和平常卡片上的辅助文字一样清楚）。画布和子流程区域的底更暗，辅助文字本来就够清楚。
					// 写在文字外面这一层而不是卡片上：卡片的描边色也按 fg-3 算，不能跟着变。
					inAnnotation && sunk && "[--fg-3:var(--fg-2)]",
					inAnnotation && "in-[.annotation-dim]:[--fg-3:var(--fg-2)]",
				)}
			>
				<div className="flex min-w-0 items-baseline gap-2.5">
					{/* 行高 1.45：中文回退字体（Noto Sans CJK 等）的字形高约 1.45em，再小时字形底部会被裁掉。 */}
					{editing && rename ? (
						<NodeTitleEditor
							id={id}
							initial={nodeDisplayName(node) ?? ""}
							placeholder={nodeDefaultTitle(node, info)}
							onCommit={(text) => rename.commit(id, text)}
							onCancel={rename.cancel}
						/>
					) : (
						<BaseNodeHeaderTitle
							ref={titleRef}
							aria-hidden
							// 显示名称放不下时截断：悬停给出全文（读屏用的全文在 aria-label 里）。
							title={named ? title : undefined}
							className={cn("min-w-0 flex-1 leading-[1.45] tracking-[0.01em]", ZOOM_TEXT_TITLE)}
						>
							{title}
						</BaseNodeHeaderTitle>
					)}
					{/* 右侧：运行时的状态（读屏读到，看得见的是站点灯）和数字；编辑时的警告、版本对比的差异。 */}
					<span
						id={statusId}
						className={cn("flex flex-none items-center gap-1 font-mono text-fg-3", ZOOM_TEXT_12)}
					>
						{running && decoration?.status && (
							<span className="sr-only">{decoration.status.label}</span>
						)}
						{running && decoration?.figure !== undefined && (
							<span data-node-figure className="in-data-[lod=true]:hidden">
								{decoration.figure}
							</span>
						)}
						{!running && decoration?.status && (
							<StatusPill kind={decoration.status.kind} className={cn("font-sans", ZOOM_TEXT_12)}>
								{/* 缩小视图时只留色点：差异已由描边颜色与差异列表说明。 */}
								<span className={LOD_HIDDEN}>{decoration.status.label}</span>
							</StatusPill>
						)}
						{!decoration && warnings.length > 0 && (
							<WarningBadge warnings={warnings} className={cn("font-sans", ZOOM_TEXT_12)} />
						)}
					</span>
				</div>
				<div
					className={cn(
						"flex min-w-0 items-center gap-2 leading-[1.35] text-fg-3",
						ZOOM_TEXT_12,
						LOD_HIDDEN,
					)}
				>
					{/*
					 * 第二行只排一行：放不下的项折到下一行、被裁掉（flex-wrap + 一行高 + overflow-hidden），不会剩下半个字。
					 * 节点 ID 不让位（开头截断、结尾整段始终可见；运行时有失败原因、主指标时最多占六成）；摘要至少要放得下
					 * 三个半字，原来的标题排在最后，放不下就整项不显示（它们都在检查器里）。
					 */}
					<div
						data-empty={(!decoration?.detail && shownSlot?.empty) || undefined}
						className="flex h-[1.35em] min-w-0 flex-1 flex-wrap items-center gap-x-2 overflow-hidden"
					>
						<span
							aria-hidden
							title={id}
							className={cn(
								"flex shrink-0 font-mono text-fg-2",
								// 运行时的失败原因、主指标排在 ID 后面，ID 最多占六成；其余时候 ID 优先，放得下摘要才显示摘要。
								decoration?.detail ? "max-w-[60%]" : "max-w-full",
							)}
						>
							{ids.head && <span className="min-w-[1.5ch] truncate">{ids.head}</span>}
							<span className="flex-none">{ids.tail}</span>
						</span>
						{decoration?.detail ?? (
							<>
								{shownSlot && (
									<span
										aria-hidden
										className={cn(
											// 按三个半字的宽度判断放不放得下（basis），放得下再撑满。
											"min-w-0 shrink grow basis-[3.5em] truncate",
											// 还没有配置的摘要（没有参数、没有映射）用辅助文字、非等宽，不像一个配置值。
											shownSlot.empty ? "text-fg-3" : "font-mono text-fg-2",
										)}
									>
										{shownSlot.text}
									</span>
								)}
								{shownCaption && (
									// 原来的标题排在最后、最多五个字宽、不压缩摘要：放不下时它整个折走，摘要留下；
									// 缩放低于 90%（data-compact）时第二行的字已经放大，不再显示它。
									<span
										aria-hidden
										className="max-w-[5.2em] shrink-0 truncate in-data-[compact=true]:hidden"
									>
										{shownCaption}
									</span>
								)}
							</>
						)}
					</div>
					{note && (
						<NoteIcon
							note={note}
							host="[data-node-id]"
							textId={noteId}
							// 警告徽标的提示在上面，键盘聚焦到同时有警告和备注的卡片时两个提示不叠在一起。
							side={!decoration && warnings.length > 0 ? "bottom" : "top"}
							className="flex-none"
						/>
					)}
				</div>
			</div>
			{decoration?.progress !== undefined && (
				// 进度线（执行中有总数的进度、等待中已经等过的时间）：卡片底边一条 2px 的线，看全图时收起。
				<span
					aria-hidden
					data-node-progress
					className="absolute right-4.5 bottom-[3px] left-14.75 h-[max(2px,calc(2px/var(--canvas-zoom)))] overflow-hidden rounded-full bg-track in-data-[lod-far=true]:hidden"
				>
					<span
						className="block h-full rounded-full bg-(--lamp-progress)"
						style={
							{
								width: `${Math.round(Math.min(1, Math.max(0, decoration.progress)) * 1000) / 10}%`,
								"--lamp-progress": decoration.status
									? LAMP[decoration.status.kind].color
									: "var(--fg-3)",
							} as CSSProperties
						}
					/>
				</span>
			)}

			{decoration?.overview !== undefined && (
				// 站外一行：缩小视图时卡片里只放得下灯和标题，执行中、失败、等待中的站在胶囊下方挂一行，写进度、剩余时间或
				// 失败原因；看全图时胶囊里只剩两三个字，前面再写上标题。和胶囊共用底色和状态描边、没有上边线，看起来是站的
				// 一部分（点它也是点这个站）；从标题的位置开始，最多 16.5 个字宽，可以伸到右边一站的下面（一条链上相邻的两站
				// 不会同时要盯）。字号、留白按屏幕上的 12px 算（em）；圆角是画布上的 12px，缩小视图时屏幕上约 4–6px。
				<span
					aria-hidden
					data-node-overview
					className={cn(
						"absolute top-full left-[calc(57px_-_0.6em)] hidden max-w-[16.5em] truncate rounded-b-xl border border-t-0 bg-canvas-node-bg px-[0.6em] pt-[0.1em] pb-[0.2em] leading-[1.45] text-fg-1",
						ZOOM_TEXT_12,
						"in-data-[lod=true]:block",
						"in-data-[run=running]:border-canvas-run-running in-data-[run=failed]:border-canvas-run-failed in-data-[run=waiting]:border-warn-line",
						"in-data-[lod-far=true]:left-[18px] in-data-[lod-far=true]:border-x-[length:max(1px,calc(2px/var(--canvas-zoom)))] in-data-[lod-far=true]:border-b-[length:max(1px,calc(2px/var(--canvas-zoom)))]",
					)}
				>
					<span className="hidden font-semibold in-data-[lod-far=true]:inline">{title} </span>
					<span className="in-data-[lod-far=true]:text-fg-2">{decoration.overview}</span>
				</span>
			)}

			{!isStart && (
				<BaseHandle
					type="target"
					position={Position.Left}
					id="chain"
					isConnectableStart={false}
					state={port.in ? "connected" : "idle"}
					style={portStyle(PORTS.in)}
				/>
			)}
			{node.kind === "subflow_entry" && (
				// 子流程入口节点没有链上的入线，左侧端口只接收调度连线。
				<BaseHandle
					type="target"
					position={Position.Left}
					id="dispatch"
					variant="dispatch"
					isConnectableStart={false}
					state={port.in ? "connected" : "idle"}
					style={portStyle(PORTS.in, true)}
				/>
			)}
			{/* 出口可以作为连线的终点：改接连线的起点时拖到这里（#185）。普通拖线从出口出发、只能连到入口。 */}
			<BaseHandle
				type="source"
				position={Position.Right}
				id="chain"
				state={port.out ? "connected" : "open"}
				title={port.out ? undefined : "链尾：可以从这里拖线追加节点"}
				style={portStyle(PORTS.out)}
			/>
			{node.kind === "async" && (
				<BaseHandle
					type="source"
					position={Position.Bottom}
					id="dispatch"
					variant="dispatch"
					state={port.dispatch ? "connected" : "idle"}
					style={portStyle(PORTS.dispatch, true)}
				/>
			)}
		</BaseNode>
	);
}

/** 每种节点都用节点卡片画；Record 的类型让新增的节点种类漏注册时类型检查报错。 */
export const nodeTypes: Record<SfNode["data"]["node"]["kind"], typeof NodeCard> = {
	entry: NodeCard,
	subflow_entry: NodeCard,
	async: NodeCard,
	timer: NodeCard,
	sleep: NodeCard,
	stop_subflow: NodeCard,
	feishu_notify: NodeCard,
	package: NodeCard,
};
