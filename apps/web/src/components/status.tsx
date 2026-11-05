import { cn } from "cn";

/**
 * 状态指示（原型 `.st`）：圆点 + 文字。配色规则见 docs/DESIGN-SYSTEM.md：
 *   ok 成功/在线（绿） · running 执行中（青，圆点脉冲） · failed 失败（红） · warn 等待/警告/安装中（琥珀）
 *   pending 待执行/离线（空心灰圈） · skipped 已跳过（淡灰空心圈） · cancelled 已取消（灰色虚线圈）
 * 状态一律用这个组件表达，不要自己拼颜色。
 */
export type StatusKind = "ok" | "running" | "failed" | "warn" | "pending" | "skipped" | "cancelled";

const TEXT: Record<StatusKind, string> = {
	ok: "text-ok",
	running: "text-signal",
	failed: "text-danger-fg",
	warn: "text-warn",
	pending: "text-pending",
	skipped: "text-skipped",
	cancelled: "text-cancelled",
};

const DOT: Record<StatusKind, string> = {
	ok: "size-1.75 bg-current",
	running: "size-1.75 bg-current animate-status-pulse",
	failed: "size-1.75 bg-danger",
	warn: "size-1.75 bg-current",
	pending: "size-2 border-[1.5px] border-current",
	skipped: "size-2 border-[1.5px] border-current opacity-70",
	cancelled: "size-2 border-[1.5px] border-dashed border-current",
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
				TEXT[kind],
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
