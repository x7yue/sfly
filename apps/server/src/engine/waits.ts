import {
	InvalidReferenceError,
	parseDuration,
	type ResolveScope,
	resolveInputs,
	timerTarget,
} from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import {
	anyTask,
	type ChainDriver,
	type ChainRow,
	firstAttempt,
	type RunRow,
	type Step,
} from "./step.js";

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
export function planWait(node: WaitNode, scope: ResolveScope, now: Date): WaitPlan {
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

/**
 * 定时 / Sleep 节点开始执行（§5）：唤醒时间已到就立即成功并返回 true；否则任务记为 waiting、
 * 唤醒时间写进 PG，由 {@link wakeTimers} 唤醒。配置无效时以 config_error 失败（不重试）并返回 false。
 */
export async function startWait(
	driver: ChainDriver,
	step: Step,
	run: RunRow,
	chain: ChainRow,
	node: WaitNode,
	scope: ResolveScope,
): Promise<boolean> {
	const wait = planWait(node, scope, step.now);
	const base = { ...firstAttempt(run, chain, node.id, step.now), startedAt: step.now };
	if (!wait.ok) {
		const [task] = await step.tx
			.insert(tasks)
			.values({ ...base, status: "running" })
			.onConflictDoNothing()
			.returning();
		if (task) await driver.failTask(step, task, "config_error", wait.message);
		return false;
	}
	const due = wait.wakeAt.getTime() <= step.now.getTime();
	await step.tx
		.insert(tasks)
		.values(
			due
				? {
						...base,
						status: "success",
						inputs: wait.inputs,
						outputs: waitOutputs(node, step.now, wait.wakeAt < step.now),
						wakeAt: wait.wakeAt,
						endedAt: step.now,
					}
				: { ...base, status: "waiting", inputs: wait.inputs, wakeAt: wait.wakeAt },
		)
		.onConflictDoNothing();
	return due;
}

/**
 * 周期扫描（control-plane.ts，默认每秒一次）：唤醒时间已到的 waiting 任务成功，链继续推进。
 * 是否到期只看注入的时钟；返回唤醒的任务数。
 */
export async function wakeTimers(driver: ChainDriver, db: Db, now: Date): Promise<number> {
	const dueBy = (n: Date) => and(eq(tasks.status, "waiting"), lte(tasks.wakeAt, n));
	if (!(await anyTask(db, dueBy(now)))) return 0;
	return driver.event(async (step) => {
		const due = await step.tx
			.select()
			.from(tasks)
			.where(dueBy(step.now))
			.orderBy(asc(tasks.wakeAt), asc(tasks.seq))
			.for("update");
		for (const task of due) {
			const { run, chain, index, node } = await driver.locate(step.tx, task);
			if (!isWaitNode(node)) throw new Error(`task ${task.id} is not a wait node`);
			await step.tx
				.update(tasks)
				.set({ status: "success", outputs: waitOutputs(node, step.now), endedAt: step.now })
				.where(eq(tasks.id, task.id));
			await driver.advance(step, run, chain, index + 1);
		}
		return due.length;
	});
}
