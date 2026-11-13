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
 * 状态指示（原型 `.st`）：圆点 + 文字。配色规则见 docs/DESIGN-SYSTEM.md：
 *   ok 成功/在线（绿） · running 执行中（青，圆点脉冲） · failed 失败（红） · warn 等待/警告/安装中（琥珀）
 *   pending 待执行/离线（空心灰圈） · skipped 已跳过（淡灰空心圈） · cancelled 已取消（灰色虚线圈）
 *   stopped 已停止（灰色实心小方块）
 * 状态一律用这个组件表达，不要自己拼颜色。
 */
export type StatusKind =
	| "ok"
	| "running"
	| "failed"
	| "warn"
	| "pending"
	| "skipped"
	| "cancelled"
	| "stopped";

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
		? { kind: display.badge, label: display.label }
		: { kind: "pending", label: status };
}

/** 运行通知的状态（运行详情里的一行）：排队中、已送达、投递失败、已丢弃（机器人被删除）、未发送（没进队列）。 */
const RUN_NOTIFICATION_KIND: Record<RunNotificationState["status"], StatusKind> = {
	queued: "pending",
	delivered: "ok",
	failed: "failed",
	discarded: "warn",
	not_sent: "warn",
};

export const runNotificationView = (status: RunNotificationState["status"]): StatusView => ({
	kind: RUN_NOTIFICATION_KIND[status],
	label: RUN_NOTIFICATION_STATUS_LABEL[status],
});

const TEXT: Record<StatusKind, string> = {
	ok: "text-ok",
	running: "text-signal",
	failed: "text-danger-fg",
	warn: "text-warn",
	pending: "text-pending",
	skipped: "text-skipped",
	cancelled: "text-cancelled",
	stopped: "text-stopped",
};

/** 状态文字的颜色：灰阶里偏淡的两种（待执行、已跳过）文字用辅助文字色，保证在所有表面上 ≥ 4.5:1；淡灰只留给圆圈。 */
const LABEL_TEXT: Record<StatusKind, string> = {
	...TEXT,
	pending: "text-fg-3",
	skipped: "text-fg-3",
};

const DOT: Record<StatusKind, string> = {
	ok: "size-1.75 bg-current",
	running: "size-1.75 bg-current animate-status-pulse",
	failed: "size-1.75 bg-danger",
	warn: "size-1.75 bg-current",
	pending: "size-2 border-[1.5px] border-current",
	skipped: "size-2 border-[1.5px] border-current opacity-70",
	cancelled: "size-2 border-[1.5px] border-dashed border-current",
	// 圆点之外唯一的方块（停止符号）：与取消、跳过区分开。
	stopped: "size-1.75 rounded-[2px] bg-current",
};

/** 只有圆点（单独使用时自带状态色，例如时间线的行标签）；需要文字时用 StatusPill。 */
export function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
	return (
		<i
			aria-hidden
			className={cn("inline-block flex-none rounded-full", TEXT[kind], DOT[kind], className)}
		/>
	);
}

export function StatusPill({
	kind,
	children,
	className,
}: {
	kind: StatusKind;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			data-status={kind}
			className={cn(
				"inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
				LABEL_TEXT[kind],
				className,
			)}
		>
			<StatusDot kind={kind} />
			{children}
		</span>
	);
}

/** 槽位占用（原型 `.slotbar`）：每个槽位一格，占用的为浅灰（中性，不用状态色）。 */
export function SlotBar({ used, total }: { used: number; total: number }) {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<span aria-hidden className="inline-flex gap-0.75">
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
