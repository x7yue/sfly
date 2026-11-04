import { parseDuration, timerTarget } from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import { InvalidReferenceError, type ReferenceScope, resolveInputs } from "./references.js";

/**
 * 内置等待节点（docs/SEMANTICS.md §5）：定时节点和 Sleep 节点由控制面的持久化定时器驱动，不占用 Agent。
 *
 * 节点开始执行时算出唤醒时间：已经到了就立即成功，否则任务记为 waiting 并把唤醒时间写进
 * `tasks.wake_at`；引擎的周期扫描（Engine.wakeTimers）把到期的任务标记为成功并继续推进链。
 * 定时器的状态只有这一行（status + wake_at），控制面重启后照常扫描。
 */

export type WaitNode = Extract<OrchestrationNode, { kind: "timer" | "sleep" }>;

export const isWaitNode = (node: OrchestrationNode): node is WaitNode =>
	node.kind === "timer" || node.kind === "sleep";

export type WaitPlan =
	| {
			ok: true;
			/** 记录在任务上的输入：解析后的配置。 */
			inputs: Record<string, unknown>;
			wakeAt: Date;
	  }
	| { ok: false; message: string };

/**
 * 节点在 now 开始执行时的等待计划。Sleep 时长里的引用在这里解析；
 * 配置无效（静态检查通常已经拦下，引用解析出的时长只能在这里发现）时返回错误，节点以 config_error 失败。
 */
export function planWait(node: WaitNode, scope: ReferenceScope, now: Date): WaitPlan {
	if (node.kind === "timer") {
		const target = timerTarget(node.at, node.tz, now);
		if (!target) {
			return { ok: false, message: `invalid timer: at "${node.at}", tz "${node.tz}"` };
		}
		return { ok: true, inputs: { at: node.at, tz: node.tz }, wakeAt: target };
	}
	let duration: unknown;
	try {
		duration = resolveInputs({ duration: node.duration }, scope).duration;
	} catch (error) {
		if (!(error instanceof InvalidReferenceError)) throw error;
		return { ok: false, message: error.message };
	}
	const ms = parseDuration(duration);
	if (ms === null) {
		return {
			ok: false,
			message: `invalid sleep duration ${JSON.stringify(duration)}: expected e.g. 30s, 10m, 1h`,
		};
	}
	return { ok: true, inputs: { duration }, wakeAt: new Date(now.getTime() + ms) };
}

/**
 * 等待节点完成时的输出：triggered_at 是实际完成时间；定时节点另有 late，
 * 只有开始执行时目标时刻已经过去才为 true。
 */
export function waitOutputs(node: WaitNode, at: Date, late = false): Record<string, unknown> {
	const triggered_at = at.toISOString();
	return node.kind === "timer" ? { triggered_at, late } : { triggered_at };
}
