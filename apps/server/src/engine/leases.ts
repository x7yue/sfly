import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import { anyTask, type ChainDriver, type Step, type TaskRow } from "./step.js";

/**
 * 租约与恢复（#15，docs/SEMANTICS.md §3.3）：
 * - 派发给 Agent 的任务有租约，Agent 的心跳为它手上的任务续约；租约过期的任务以 agent_lost 失败；
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
					eq(tasks.status, "running"),
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

/** Agent 心跳：为控制面认为在它上面运行的全部任务续约到 until。 */
export async function renewLeases(db: Db, agentName: string, until: Date): Promise<void> {
	await db
		.update(tasks)
		.set({ leaseExpiresAt: until })
		.where(and(eq(tasks.agentName, agentName), eq(tasks.status, "running")));
}

/**
 * 周期扫描（control-plane.ts）：租约过期的运行中任务以 agent_lost 失败（按重试配置派回同一个 Agent），
 * 排队超时的任务以 env_error 失败（不重试）。返回失败的任务数。
 */
export async function expireTasks(driver: ChainDriver, db: Db, now: Date): Promise<number> {
	const expired = (n: Date) =>
		or(
			and(eq(tasks.status, "running"), lte(tasks.leaseExpiresAt, n)),
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

/** 任务所在的 Agent 失联：agent_lost，按重试配置派回同一个 Agent。 */
export async function agentLost(
	driver: ChainDriver,
	step: Step,
	task: TaskRow,
	reason: string,
): Promise<void> {
	// 槽位释放了：Agent 在线时可以派发它的其他排队任务。
	if (task.agentName) step.touchedAgents.add(task.agentName);
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
