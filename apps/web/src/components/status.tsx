import type { RunNotificationState, RunStatus } from "@sfly/schema";
import { cn } from "cn";
import {
	CANCELLING_LABEL,
	FORCE_CANCELLING_LABEL,
	RUN_NOTIFICATION_STATUS_LABEL,
	RUN_STATUS_LABEL,
} from "#/lib/copy";
import { nodeStatusDisplay } from "#/lib/node-status";

/**
 * 状态语法见 docs/DESIGN-SYSTEM.md §6.1。状态一律用这些组件表达，不要自己拼颜色。
 */
export type StatusKind =
	| "ok"
	| "running"
	| "failed"
	| "warn"
	| "pending"
	| "queued"
	| "skipped"
	| "cancelled"
	| "stopped";

/** 7–8px 状态标记的形状：每种状态一个，不看颜色（色觉缺陷、强制颜色模式）、不看动画（减少动效）也能分辨。 */
export type StatusMark =
	| "disc"
	| "ring-dot"
	| "diamond"
	| "triangle"
	| "ring"
	| "half"
	| "slashed"
	| "dashed"
	| "square";

export interface StatusLook {
	tone: string;
	/** 状态文字的颜色：彩色状态用 -fg 文字色，偏淡的灰阶用辅助文字色，在所有表面上 ≥ 4.5:1。 */
	text: string;
	mark: StatusMark;
	area: {
		/**
		 * 需要处理或正在发生的状态（执行中、失败、等待）满高，其余矮一档：
		 * 红色盲看来失败的红和成功的绿几乎同色，靠高度分开。
		 */
		tall: boolean;
		box: string;
		svg: string;
	};
	pulse: boolean;
}

export const STATUS: Record<StatusKind, StatusLook> = {
	ok: {
		tone: "text-ok",
		text: "text-ok",
		mark: "disc",
		area: { tall: false, box: "bg-ok-fill", svg: "fill-ok-fill" },
		pulse: false,
	},
	running: {
		tone: "text-signal",
		text: "text-signal-fg",
		mark: "ring-dot",
		area: {
			tall: true,
			box: "border border-signal-line bg-signal-fill",
			svg: "fill-signal-fill stroke-signal-line",
		},
		pulse: true,
	},
	failed: {
		tone: "text-danger",
		text: "text-danger-fg",
		mark: "diamond",
		area: { tall: true, box: "bg-danger-fill", svg: "fill-danger-fill" },
		pulse: false,
	},
	warn: {
		tone: "text-warn",
		text: "text-warn-fg",
		mark: "triangle",
		area: {
			tall: true,
			box: "border border-warn-line bg-warn-fill",
			svg: "fill-warn-fill stroke-warn-line",
		},
		pulse: false,
	},
	pending: {
		tone: "text-pending",
		text: "text-fg-3",
		mark: "ring",
		area: { tall: false, box: "bg-pending-fill", svg: "fill-pending-fill" },
		pulse: false,
	},
	// 排队是「轮到了，在等 Agent 的槽位」，不是要人处理的等待，所以是中性灰；斜纹（缩略图里是描边）与待执行的空槽区分。
	queued: {
		tone: "text-pending",
		text: "text-fg-3",
		mark: "half",
		area: {
			tall: false,
			box: "bg-pending-fill bg-[repeating-linear-gradient(135deg,var(--pending)_0_1.5px,transparent_1.5px_4px)]",
			svg: "fill-pending-fill stroke-pending",
		},
		pulse: false,
	},
	skipped: {
		tone: "text-skipped",
		text: "text-fg-3",
		mark: "slashed",
		area: {
			tall: false,
			box: "border border-border-strong",
			svg: "fill-none stroke-border-strong",
		},
		pulse: false,
	},
	cancelled: {
		tone: "text-cancelled",
		text: "text-cancelled",
		mark: "dashed",
		area: {
			tall: false,
			box: "border border-dashed border-cancelled",
			svg: "fill-none stroke-cancelled [stroke-dasharray:2_2]",
		},
		pulse: false,
	},
	// 停止是场景的正常流程（子流程被停止子流程节点停止），不用警示色；与成功同为矮段，靠描边区分。
	stopped: {
		tone: "text-stopped",
		text: "text-stopped",
		mark: "square",
		area: {
			tall: false,
			box: "border border-stopped bg-stopped-fill",
			svg: "fill-stopped-fill stroke-stopped",
		},
		pulse: false,
	},
};

/** 运行状态与链实例状态的显示（各页面共用这一张表）。 */
const RUN_STATUS_KIND: Record<RunStatus, StatusKind> = {
	running: "running",
	success: "ok",
	failed: "failed",
	cancelled: "cancelled",
};

export interface StatusView {
	kind: StatusKind;
	label: string;
}

/**
 * 运行（或链实例）的状态：已请求取消、还没结束的显示为「取消中」（强制终止后「强制终止中」），
 * 不显示成「运行中」（故事 70）。
 */
export function runStatusView(
	status: string,
	cancel?: { cancelling: boolean; forced?: boolean },
): StatusView {
	if (status === "running" && cancel?.cancelling) {
		return {
			kind: "cancelled",
			label: cancel.forced ? FORCE_CANCELLING_LABEL : CANCELLING_LABEL,
		};
	}
	const known = status in RUN_STATUS_KIND;
	return known
		? { kind: RUN_STATUS_KIND[status as RunStatus], label: RUN_STATUS_LABEL[status as RunStatus] }
		: { kind: "pending", label: status };
}

/** 节点（最后一次尝试）的状态；显示规则见 lib/node-status。 */
export function nodeStatusView(status: string): StatusView {
	const display = nodeStatusDisplay(status);
	return display
		? { kind: display.kind, label: display.label }
		: { kind: "pending", label: status };
}

/** 运行通知的状态（运行详情里的一行）：排队中、已送达、投递失败、已丢弃（机器人被删除）、未发送（没进队列）。 */
const RUN_NOTIFICATION_KIND: Record<RunNotificationState["status"], StatusKind> = {
	queued: "queued",
	delivered: "ok",
	failed: "failed",
	discarded: "warn",
	not_sent: "warn",
};

export const runNotificationView = (status: RunNotificationState["status"]): StatusView => ({
	kind: RUN_NOTIFICATION_KIND[status],
	label: RUN_NOTIFICATION_STATUS_LABEL[status],
});

const RING = <circle cx={4} cy={4} r={3.25} fill="none" strokeWidth={1.5} />;
const MARK: Record<StatusMark, React.ReactNode> = {
	disc: <circle cx={4} cy={4} r={3.5} />,
	"ring-dot": (
		<>
			<circle cx={4} cy={4} r={3.5} fill="none" strokeWidth={1} />
			<circle cx={4} cy={4} r={2} />
		</>
	),
	diamond: <path d="M4 .25 7.75 4 4 7.75 .25 4Z" />,
	triangle: <path d="M4 .5 7.9 7.5H.1Z" />,
	ring: RING,
	half: (
		<>
			{RING}
			<path d="M4 .75a3.25 3.25 0 0 0 0 6.5Z" />
		</>
	),
	slashed: (
		<>
			{RING}
			<path d="M1.7 6.3 6.3 1.7" fill="none" strokeWidth={1.5} />
		</>
	),
	dashed: (
		<circle cx={4} cy={4} r={3.25} fill="none" strokeWidth={1.5} strokeDasharray="1.6 1.35" />
	),
	square: <rect x={0.75} y={0.75} width={6.5} height={6.5} rx={1} />,
};

/**
 * 状态标记（单独使用时自带状态色，例如时间线的行标签）；需要文字时用 StatusPill。
 * 默认静止；`pulse` 只对执行中生效，一屏里每个执行中的对象只在它的前沿打开一处。
 */
export function StatusDot({
	kind,
	pulse = false,
	className,
}: {
	kind: StatusKind;
	pulse?: boolean;
	className?: string;
}) {
	const look = STATUS[kind];
	return (
		<i
			aria-hidden
			data-status-dot={kind}
			className={cn(
				"relative inline-grid size-2 flex-none place-items-center rounded-full",
				look.tone,
				pulse && look.pulse && "pulse-ring",
				className,
			)}
		>
			<svg
				aria-hidden="true"
				viewBox="0 0 8 8"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth={0}
				className="size-full overflow-visible"
			>
				{MARK[look.mark]}
			</svg>
		</i>
	);
}

export function StatusPill({
	kind,
	pulse = false,
	children,
	className,
}: {
	kind: StatusKind;
	pulse?: boolean;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			data-status={kind}
			className={cn(
				"inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
				STATUS[kind].text,
				className,
			)}
		>
			<StatusDot kind={kind} pulse={pulse} />
			{children}
		</span>
	);
}

/**
 * 页面上所有执行中的脉冲同一相位：新挂载的脉冲（新链路、重试）对齐到文档时间线的同一节拍，不会此起彼伏。
 * 在应用入口调用一次。
 */
export function alignPulses(root: Document) {
	root.addEventListener("animationstart", (event) => {
		if (event.animationName !== "status-pulse" || !(event.target instanceof Element)) return;
		for (const animation of event.target.getAnimations({ subtree: true })) {
			if (animation instanceof CSSAnimation && animation.animationName === "status-pulse") {
				animation.startTime = 0;
			}
		}
	});
}

/** 槽位占用（原型 `.slotbar`）：每个槽位一格，占用的为浅灰（中性，不用状态色）。 */
export function SlotBar({ used, total }: { used: number; total: number }) {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<span aria-hidden data-viz className="inline-flex gap-0.75">
				{Array.from({ length: total }, (_, i) => (
					<b
						// biome-ignore lint/suspicious/noArrayIndexKey: 槽位按序号排列，没有其他标识
						key={i}
						className={cn("size-2.25 rounded-[2px]", i < used ? "bg-fg-2" : "bg-track")}
					/>
				))}
			</span>
			<span className="font-mono text-xs text-fg-2">
				{used}/{total}
			</span>
		</span>
	);
}
