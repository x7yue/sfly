import type { Readiness, SessionStatus, SessionTool } from "@sfly/schema";
import type { StatusKind } from "#/components/status";
import { SESSION } from "#/lib/copy";
import { formatDuration } from "#/lib/format";
import type { TimelineItem, ToolResultInfo } from "./timeline";

/** 助手页和会话页写的文字：由事件和状态算出一句话，纯函数（`session-text.test.ts`）。 */

/** 会话的状态：写什么字、用哪个状态形状（空闲是中性的，在做是执行中，已结束是中性的停止）。 */
export const SESSION_STATUS: Record<SessionStatus, { label: string; kind: StatusKind }> = {
	idle: { label: SESSION.status.idle, kind: "pending" },
	running: { label: SESSION.status.running, kind: "running" },
	queued: { label: SESSION.status.queued, kind: "queued" },
	ended: { label: SESSION.status.ended, kind: "stopped" },
};

/** 助手页顶部的就绪状态：就绪的写一行，不就绪的逐条写缺什么（每条取就绪状态里给人看的那句话）。 */
export function readinessProblems(readiness: Readiness): string[] {
	return readiness.problems.map((problem) =>
		problem.kind === "workbench_offline" &&
		readiness.workbench !== null &&
		!problem.message.includes(readiness.workbench)
			? SESSION.workbenchOffline(readiness.workbench)
			: problem.message,
	);
}

/** 工具调用那一行的文字：命令写成 `$ <命令>`，读、写、编辑写成「读 / 写 / 改 <路径>」。 */
export function toolLine(tool: SessionTool | null, title: string): string {
	switch (tool) {
		case "command":
			return `${SESSION.tool.command} ${title}`;
		case "read":
			return `${SESSION.tool.read} ${title}`;
		case "write":
			return `${SESSION.tool.write} ${title}`;
		case "edit":
			return `${SESSION.tool.edit} ${title}`;
		case null:
			return title === "" ? SESSION.tool.unknown : `${SESSION.tool.unknown} ${title}`;
	}
}

/**
 * 工具结果的摘要（放在那一行的右边）：命令写「退出码 N · 用时 …」，其余写「用时 …」；出错的开头写「出错」；
 * 结果太长只留了头尾的，写明「只显示了头尾」。
 */
export function toolResultSummary(tool: SessionTool | null, result: ToolResultInfo): string {
	const parts: string[] = [];
	if (result.isError) parts.push(SESSION.tool.failed);
	if (tool === "command" && result.exitCode !== undefined) {
		parts.push(SESSION.tool.exitCode(result.exitCode));
	}
	parts.push(SESSION.tool.duration(formatDuration(result.durationMs)));
	if (result.truncated) parts.push(SESSION.tool.truncated);
	return parts.join(" · ");
}

/** 一轮结束的分隔行：六种结局各一句；到了上限按 `limit_kind` 写是哪一种，不看 `reason` 的文字。 */
export function turnEndText(item: Extract<TimelineItem, { kind: "turn_end" }>): string {
	const t = SESSION.turnEnd;
	switch (item.outcome) {
		case "completed":
			return [
				t.completed,
				...(item.steps === undefined ? [] : [t.steps(item.steps)]),
				t.duration(formatDuration(item.durationMs)),
			].join(" · ");
		case "stopped":
			return t.stopped;
		case "limit":
			return t.limit(
				item.limitKind === "duration"
					? t.limitDuration(formatDuration(item.durationMs))
					: t.modelCalls(item.modelCalls),
			);
		case "interrupted":
			return t.interrupted(item.reason);
		case "model_unavailable":
			return t.modelUnavailable(item.reason);
		case "failed":
			return t.failed(item.reason);
	}
}

/** 一轮结束那一行的语气：完成和停止是中性的，到了上限是提醒，其余是出了问题。 */
export function turnEndTone(
	outcome: Extract<TimelineItem, { kind: "turn_end" }>["outcome"],
): "neutral" | "warn" | "danger" {
	switch (outcome) {
		case "completed":
		case "stopped":
			return "neutral";
		case "limit":
			return "warn";
		case "interrupted":
		case "model_unavailable":
		case "failed":
			return "danger";
	}
}
