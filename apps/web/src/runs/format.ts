/** 运行 / 节点状态的显示（视觉对齐原型 node.css 的 r-done / r-current / r-failed / r-pending）。 */

export type RunTone = "done" | "current" | "failed" | "pending";

const STATUS: Record<string, { label: string; tone: RunTone }> = {
	pending: { label: "待执行", tone: "pending" },
	queued: { label: "排队中", tone: "pending" },
	// 已派发给 Agent，还在下载/安装节点包或启动执行器；Agent 上报 TaskStarted 后才是“执行中”。
	dispatched: { label: "准备中", tone: "current" },
	waiting: { label: "等待中", tone: "current" },
	running: { label: "执行中", tone: "current" },
	success: { label: "成功", tone: "done" },
	failed: { label: "失败", tone: "failed" },
	skipped: { label: "已跳过", tone: "pending" },
	cancelled: { label: "已取消", tone: "pending" },
};

export const statusLabel = (status: string) => STATUS[status]?.label ?? status;
export const statusTone = (status: string): RunTone => STATUS[status]?.tone ?? "pending";

/** 运行（而不是节点）的状态文字：运行只有 running / success / failed / cancelled。 */
export const runStatusLabel = (status: string) =>
	status === "running" ? "运行中" : statusLabel(status);

export const ERROR_KIND_LABEL: Record<string, string> = {
	node_error: "节点错误",
	timeout: "超时",
	agent_lost: "Agent 断线",
	env_error: "环境错误",
	config_error: "配置错误",
};

/** 耗时：850ms、12.3s、3m 05s、1h 02m。 */
export function formatDuration(duration: number): string {
	const ms = Math.max(0, duration);
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 从 start 到 end（还没结束时到 now）的耗时。 */
export const durationBetween = (start: string, end: string | null, now: number) =>
	formatDuration((end ? Date.parse(end) : now) - Date.parse(start));

export const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export const shortId = (id: string) => id.slice(0, 8);
