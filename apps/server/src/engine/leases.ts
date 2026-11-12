import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { ON_AGENT, tasks } from "../db/schema.js";
import type { RunningTaskRef } from "../gateway/agent-gateway.js";
import { anyTask, type ChainDriver, type Step, type TaskRow } from "./step.js";

/**
 * 租约与恢复（#15，docs/SEMANTICS.md §3.3）：
 * - 派发给 Agent 的任务（dispatched / running）有租约，Agent 的心跳只为它上报的手上任务续约；
 *   租约过期、或连续两次心跳都没有上报的任务以 agent_lost 失败；
 * - 排队超过 queue_timeout 的任务以 env_error 失败；
 * - 控制面重启时给租约和排队超时留出 Agent 重连的时间。
 * 都在引擎的互斥锁下执行（调用方负责），是否到期只看注入的时钟。
 */

/** 运行中任务的默认租约：30 秒；Agent 按它的三分之一（10 秒）发送心跳（#15）。 */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * 控制面启动时：运行、链实例、任务和定时器的状态都在 PG 里，不需要重放；
 * 只是停机期间 Agent 无法心跳、也无法被派发，所以把已经（或即将）到期的租约和排队超时
 * 顺延到 grace（至少一个租约之后），给 Agent 重新连接、在 Hello 里上报手上任务的时间。
 */
export async function extendForRecovery(db: Db, grace: Date): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(tasks)
			.set({ leaseExpiresAt: grace })
			.where(
				and(
					inArray(tasks.status, ON_AGENT),
					isNotNull(tasks.agentName),
					or(isNull(tasks.leaseExpiresAt), lt(tasks.leaseExpiresAt, grace)),
				),
			);
		await tx
			.update(tasks)
			.set({ queueExpiresAt: grace })
			.where(and(eq(tasks.status, "queued"), lt(tasks.queueExpiresAt, grace)));
	});
}

/** 每个 Agent 上一次心跳没有上报的任务（`task_id:attempt`）；只在内存里，重连时清空。 */
export class MissedHeartbeats {
	#missed = new Map<string, Set<string>>();

	/** 记下这次没有上报的任务，返回上一次也没有上报的那些。 */
	record(agentName: string, missing: string[]): Set<string> {
		const before = this.#missed.get(agentName) ?? new Set();
		this.#missed.set(agentName, new Set(missing));
		return new Set(missing.filter((key) => before.has(key)));
	}

	reset(agentName: string): void {
		this.#missed.delete(agentName);
	}
}

const keyOf = (t: { id?: string; taskId?: string; attempt: number }) =>
	`${t.id ?? t.taskId}:${t.attempt}`;

/**
 * 按 Agent 上报的手上任务（Hello / Heartbeat 的 running_tasks）处置控制面认为派发给它的任务 mine：
 * 上报了的续约到 lease；没上报的以 agent_lost 失败——Hello 立即失败；心跳给 suspects 时，
 * 连续两次心跳都没上报才失败（第一次可能是心跳与派发消息在路上交错）。
 */
export async function renewHeld(
	driver: ChainDriver,
	step: Step,
	agentName: string,
	mine: TaskRow[],
	held: RunningTaskRef[],
	options: { lease: Date; missing: string; suspects?: MissedHeartbeats },
): Promise<void> {
	const reported = new Set(held.map(keyOf));
	const kept = mine.filter((t) => reported.has(keyOf(t)));
	if (kept.length > 0) {
		await step.tx
			.update(tasks)
			.set({ leaseExpiresAt: options.lease })
			.where(
				inArray(
					tasks.id,
					kept.map((t) => t.id),
				),
			);
	}
	const missing = mine.filter((t) => !reported.has(keyOf(t)));
	const lost = options.suspects
		? options.suspects.record(agentName, missing.map(keyOf))
		: new Set(missing.map(keyOf));
	for (const task of missing) {
		if (lost.has(keyOf(task))) await agentLost(driver, step, task, options.missing);
	}
}

/**
 * 周期扫描（control-plane.ts）：租约过期的运行中任务以 agent_lost 失败（按重试配置派回同一个 Agent），
 * 排队超时的任务以 env_error 失败（不重试）。返回失败的任务数。
 */
export async function expireTasks(driver: ChainDriver, db: Db, now: Date): Promise<number> {
	const expired = (n: Date) =>
		or(
			and(inArray(tasks.status, ON_AGENT), lte(tasks.leaseExpiresAt, n)),
			and(eq(tasks.status, "queued"), lte(tasks.queueExpiresAt, n)),
		);
	if (!(await anyTask(db, expired(now)))) return 0;
	return driver.event(async (step) => {
		const due = await step.tx
			.select()
			.from(tasks)
			.where(expired(step.now))
			.orderBy(asc(tasks.seq))
			.for("update");
		for (const task of due) {
			if (task.status === "queued") await queueTimedOut(driver, step, task);
			else await agentLost(driver, step, task, "任务租约已过期");
		}
		return due.length;
	});
}

/**
 * 任务所在的 Agent 失联：agent_lost，按重试配置派回同一个 Agent。
 * Agent 可能其实还连着（租约在连接正常时过期、派发消息晚到），这次尝试仍在它上面执行：同时强制取消它，
 * 提交后先于下一次尝试的派发发出（#215）。连接已断开或还没推送 Welcome 时不发，重连时由 Welcome 的 ABANDON 停掉。
 */
export async function agentLost(
	driver: ChainDriver,
	step: Step,
	task: TaskRow,
	reason: string,
): Promise<void> {
	if (task.agentName) {
		// 槽位释放了：Agent 在线时可以派发它的其他排队任务。
		step.touchedAgents.add(task.agentName);
		step.cancels.push({
			agentName: task.agentName,
			taskId: task.id,
			attempt: task.attempt,
			force: true,
		});
	}
	await driver.failTask(step, task, "agent_lost", `Agent ${task.agentName} 失联：${reason}`);
}

/** 排队超时：env_error，不重试（§3.3）。 */
export async function queueTimedOut(driver: ChainDriver, step: Step, task: TaskRow): Promise<void> {
	const seconds = Math.round(
		((task.queueExpiresAt?.getTime() ?? 0) - task.queuedAt.getTime()) / 1000,
	);
	await driver.failTask(
		step,
		task,
		"env_error",
		`排队超过 ${seconds} 秒仍未派发：Agent ${task.agentName} 不在线或没有空闲槽位`,
	);
}
