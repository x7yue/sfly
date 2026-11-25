import type { Readiness, SessionStatus, SessionTool, WaitingFor } from "@sfly/schema";
import type { StatusKind } from "#/components/status";
import { SESSION } from "#/lib/copy";
import { formatDuration } from "#/lib/format";
import {
	hasBehind,
	type SteerDelivery,
	type TimelineItem,
	type TimelineQueue,
	type TimelineState,
	type ToolResultInfo,
	type UserRole,
} from "./timeline";

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

/**
 * 一轮结束的分隔行：六种结局各一句；到了上限按 `limit_kind` 写是哪一种，不看 `reason` 的文字。
 * **「已停止」不写 `reason`**：结局的原因是助手服务写的「用户停止了这一轮」，而这一轮不一定是用户点了停止才停的（控制面发给助手服务的
 * 中止命令超时、随后补发的中止让助手服务马上结束了这一轮，用户其实没有点过停止），页面不把它原样说成用户的操作。
 */
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

/** 时间线上用户的一句话的标记：开一轮的话没有标记；插话、排在这一轮后面的话、被撤掉的话各一个。 */
export function userRoleLabel(role: UserRole): string | null {
	switch (role) {
		case "turn":
			return null;
		case "steer":
			return SESSION.message.steer;
		case "behind":
			return SESSION.message.behind;
		case "cancelled":
			return SESSION.message.cancelled;
	}
}

/** 插话送到了没有：等待送达、已送到、没有送到各一个字样；不知道（刷新后读到在做的一轮里的插话）时没有。 */
export function steerDeliveryLabel(delivery: SteerDelivery | null): string | null {
	switch (delivery) {
		case "waiting":
			return SESSION.message.waiting;
		case "delivered":
			return SESSION.message.delivered;
		case "dropped":
			return SESSION.message.dropped;
		case "unknown":
		case null:
			return null;
	}
}

/** 会话的状态那一格：排队中（和停止途中说了话、排在这一轮后面的在做的会话）后面写排第几。 */
export function statusWithQueue(status: SessionStatus, position: number | null): string {
	const label = SESSION_STATUS[status].label;
	return position === null ? label : `${label} · ${SESSION.list.queuePosition(position)}`;
}

/**
 * 输入框此刻是什么样（只由状态算）：
 * - `send` 空闲：接着说；
 * - `steer` 在做：发出去的是插话；
 * - `behind` 在做、而且停止途中说的话排在这一轮后面：不能再说，停止按钮写「撤掉排着的话」、点它是撤掉那句话（按钮的字只由这个状态定）；
 * - `queued` 排队中：不能说，写排在第几位、在等谁；
 * - `ended` 已结束：不显示输入框。
 */
export type ComposerMode =
	| { kind: "send" }
	| { kind: "steer" }
	| { kind: "behind"; position: number | null }
	| { kind: "queued"; position: number | null; waitingFor: WaitingFor | null }
	| { kind: "ended" };

export function composerMode(
	state: Pick<TimelineState, "status" | "queue" | "items">,
): ComposerMode {
	switch (state.status) {
		case "idle":
			return { kind: "send" };
		case "ended":
			return { kind: "ended" };
		case "queued":
			return {
				kind: "queued",
				position: state.queue?.position ?? null,
				waitingFor: state.queue?.waitingFor ?? null,
			};
		case "running":
			return hasBehind(state.items)
				? { kind: "behind", position: state.queue?.position ?? null }
				: { kind: "steer" };
	}
}

/** 顶栏状态那一格的字：排队中写排第几。 */
export function sessionStatusText(state: Pick<TimelineState, "status" | "queue">): string {
	return statusWithQueue(
		state.status,
		state.status === "queued" ? (state.queue?.position ?? null) : null,
	);
}

/** 排队的话在会话视图里是 `TimelineQueue`：列表项只有位置。 */
export const queueOf = (
	position: number | null,
	waitingFor: WaitingFor | null,
): TimelineQueue | null => (position === null ? null : { position, waitingFor });

/**
 * 读屏要播报的一句：状态变了、看得见却听不到的几件事——这个会话轮到了、有一句插话没有送到、这一轮结束了、会话被结束了（可能是别人结束的）。
 * 两份状态之间没有这些变化时返回 `null`。页面用它填「一轮结束」那块 `aria-live` 的区域（时间线是逐字更新的，不整个播报）。
 *
 * **只看新到的事件**：序号大于之前最大序号（`before.lastSeq`）的那几行。往前翻页（`prependHistory`）把更早的行放到前面，最大序号不变，
 * 所以读进来的旧事件永远不播；打开页面时前后是同一份状态，也不播。一次到了好几条（重连之后补发，被合成一次渲染）时，播的是这一批的
 * 事实：一句「有一句插话没有送到」、**最近的一个结局**一句，不把过去几轮逐条念一遍。
 */
export function announcement(
	before: Pick<TimelineState, "status" | "items" | "lastSeq">,
	after: Pick<TimelineState, "status" | "items" | "lastSeq">,
): string | null {
	const lines: string[] = [];
	const fresh = after.items.filter(
		(item) => "seq" in item && item.seq !== null && item.seq > before.lastSeq,
	);
	if (fresh.some((item) => item.kind === "notice" && item.noticeKind === "steer_dropped")) {
		lines.push(SESSION.page.announce.steerDropped);
	}
	if (before.status === "queued" && after.status === "running") {
		lines.push(SESSION.page.announce.started);
	}
	const lastEnd = fresh.filter((item) => item.kind === "turn_end").at(-1);
	if (lastEnd?.kind === "turn_end") lines.push(turnEndText(lastEnd));
	if (after.status === "ended" && before.status !== "ended") {
		const ended = fresh.filter((item) => item.kind === "session_ended").at(-1);
		lines.push(SESSION.page.announce.ended(ended?.kind === "session_ended" ? ended.by : ""));
	}
	return lines.length === 0 ? null : lines.join("。");
}
