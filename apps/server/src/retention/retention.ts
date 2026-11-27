import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	apiTokens,
	artifacts,
	feishuMessages,
	runs,
	taskActionNames,
	taskActionSummaries,
	taskActions,
	tasks,
} from "../db/schema.js";
import { runVaults } from "../db/vault-schema.js";
import { isLockTimeout } from "../sessions/session-store.js";

/** 日志和产物的默认保留期：30 天。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 每次清理最多处理的运行数（剩下的下次扫描继续）。 */
const BATCH = 100;

/**
 * {@link Retention.isPurgedAfterWait} 最多等多久（毫秒）：清理删一个大目录要几秒，读日志的请求在认出文件有问题之后才会等；
 * 等不到就按「正在清理」处理，所以这个数只决定最多拖慢这一种请求多久，不影响回答。
 */
export const DEFAULT_PURGE_WAIT_MS = 3_000;

/**
 * 日志和产物的保留期清理（#18）：运行结束超过保留期后，删除它的日志目录 `logs/<run_id>/`、
 * 产物目录 `artifacts/<run_id>/` 和产物记录，这个运行的飞书投递记录（ADR 0020），以及它的任务的动作明细、每种名称的
 * 计数和动作摘要（规格 #345），它的任务的任务凭据（`api_tokens` 里种类为 `task` 的行，任务早已结束，凭据早就无效，#492），
 * 并在 `runs.purged_at` 记下清理时间。
 * 运行本身、任务状态和输出都保留。是否到期只按注入的时钟判断，测试推进手动时钟即可。
 */
export class Retention {
	#sweeping: Promise<number> | undefined;
	/** 正在等清理提交的核对（{@link isPurgedAfterWait}）：同一个运行同时只发一次。 */
	readonly #waiting = new Map<string, Promise<boolean>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			dataDir: string;
			/** 保留天数，默认 {@link DEFAULT_RETENTION_DAYS}。 */
			retentionDays?: number;
			/** {@link Retention.isPurgedAfterWait} 最多等多久（毫秒），默认 {@link DEFAULT_PURGE_WAIT_MS}。 */
			purgeWaitMs?: number;
			/** 清理时删掉了这个运行的加密副本（#505：Agent 一直没回来，保留期就是上限），提交之后告诉 `RunSecrets`。 */
			onVaultDeleted: (runId: string) => void;
		},
	) {}

	get retentionMs(): number {
		return (this.deps.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
	}

	/** 清理到期的运行，返回清理了几个；上一次扫描还没结束时等它结束。 */
	sweep(): Promise<number> {
		this.#sweeping ??= this.#sweep().finally(() => {
			this.#sweeping = undefined;
		});
		return this.#sweeping;
	}

	/** 等正在进行的扫描结束（关闭控制面前调用）。 */
	async idle(): Promise<void> {
		await this.#sweeping?.catch(() => {});
	}

	/** 运行的日志和产物是否已被清理。 */
	async isPurged(runId: string): Promise<boolean> {
		const [row] = await this.deps.db
			.select({ id: runs.id })
			.from(runs)
			.where(and(eq(runs.id, runId), isNotNull(runs.purgedAt)));
		return row !== undefined;
	}

	/**
	 * 日志文件有问题（不见了、变短了）时，核对它是不是保留期清理正在删（#734 的审查）：清理在一个事务里先锁住运行的行（`FOR UPDATE`）、
	 * 再删这个运行的日志目录、最后写 `purged_at` 提交，删大目录要几秒；这期间 {@link isPurged} 读不到还没提交的 `purged_at`，
	 * 读日志的请求会把「正在被清理」说成「日志文件不在了」。所以只在**认出了问题之后**用 `FOR KEY SHARE` 再读一次（产物上传核对运行有没有被
	 * 清理用的是同一个办法）：它只和清理的 `FOR UPDATE` 冲突，引擎对运行行的普通更新不等它；清理提交之后读到的是已清理，等到了就按它回；
	 * 没有问题的请求不多查任何东西。
	 *
	 * **等待有上界**（`lock_timeout`，{@link DEFAULT_PURGE_WAIT_MS}）：等不到就是还有事务持着运行行的 `FOR UPDATE`，控制面里这样锁运行行的只有
	 * 两处——保留期清理（删着目录，几秒）和 {@link Engine.cancel}（几个查询，毫秒）；取消在已经结束的运行上马上以 409 返回，而清理只处理结束超过
	 * 保留期的运行，两者不会同时拿着同一个到期运行的锁很久，所以等不到就是清理还在删：按「已清理」处理（回 `expired`，正是接下来要变成的样子）。
	 * 清理出错回滚、`purged_at` 没有写上时，读到的是「没清理」，文件真的不在了，照常说文件的问题（下一次扫描会重新清理它）。
	 */
	isPurgedAfterWait(runId: string): Promise<boolean> {
		// 同一个运行同时有很多读日志的请求在等时共用一次核对：每个等着的核对占着一个数据库连接（连接池只有 10 个），清理删目录的
		// 几秒里一批请求各占一个，会把连接池占满、挡住别的请求。后来的请求拿到的是这一次核对的结果（等清理提交之后读到的）。
		const running = this.#waiting.get(runId);
		if (running) return running;
		const check = this.#purgedAfterWait(runId).finally(() => this.#waiting.delete(runId));
		this.#waiting.set(runId, check);
		return check;
	}

	async #purgedAfterWait(runId: string): Promise<boolean> {
		const waitMs = this.deps.purgeWaitMs ?? DEFAULT_PURGE_WAIT_MS;
		try {
			return await this.deps.db.transaction(async (tx) => {
				await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
				const [row] = await tx
					.select({ purgedAt: runs.purgedAt })
					.from(runs)
					.where(eq(runs.id, runId))
					.for("key share");
				return row?.purgedAt != null;
			});
		} catch (error) {
			if (isLockTimeout(error)) return true;
			throw error;
		}
	}

	async #sweep(): Promise<number> {
		const now = this.deps.clock.now();
		const cutoff = new Date(now.getTime() - this.retentionMs);
		const due = await this.deps.db
			.select({ id: runs.id })
			.from(runs)
			.where(and(isNull(runs.purgedAt), lt(runs.endedAt, cutoff)))
			.limit(BATCH);
		for (const { id } of due) {
			const vaultDeleted = await this.deps.db.transaction(async (tx) => {
				// 先锁住这个运行的行（`FOR UPDATE`），再删文件、删产物行、标记已清理，一起提交（#649 的审查）：产物上传
				// （`ArtifactStore`）在 `FOR KEY SHARE` 的锁下核对运行没有被清理、改名、记账，两边不会交错：上传在改名中时这里等它
				// 提交，之后删文件和行时连它存下的一起删；这里拿到锁之后上传的核对要等这个事务提交、读到「已清理」，不改名也不记账。
				// 不然上传进行中运行被清理时，文件会落进已经清理过的目录、库里多一行，没有人再删。
				// 次序没变：先删文件、再标记，在同一个事务里：中途出错或进程被杀，事务回滚、没有标记，下一次扫描重新处理（删除是
				// 幂等的）。代价是删文件期间事务开着、持着这一个运行行的锁（一个运行一把，批次里顺序做）：大目录要几秒；这个运行
				// 结束已经超过保留期，没有别的事务要更新它。
				const [locked] = await tx
					.select({ purgedAt: runs.purgedAt })
					.from(runs)
					.where(eq(runs.id, id))
					.for("update");
				if (!locked || locked.purgedAt !== null) return false; // 选出来之后别处已经清理了
				await Promise.all(
					["logs", "artifacts"].map((dir) =>
						rm(join(this.deps.dataDir, dir, id), { recursive: true, force: true }),
					),
				);
				const runTasks = tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.runId, id));
				await tx.delete(taskActions).where(inArray(taskActions.taskId, runTasks));
				await tx.delete(taskActionNames).where(inArray(taskActionNames.taskId, runTasks));
				await tx.delete(taskActionSummaries).where(inArray(taskActionSummaries.taskId, runTasks));
				await tx
					.delete(apiTokens)
					.where(and(eq(apiTokens.kind, "task"), inArray(apiTokens.taskId, runTasks)));
				await tx.delete(artifacts).where(eq(artifacts.runId, id));
				await tx.delete(feishuMessages).where(eq(feishuMessages.runId, id));
				const vaults = await tx.delete(runVaults).where(eq(runVaults.runId, id)).returning();
				await tx
					.update(runs)
					.set({
						purgedAt: now,
						...(vaults.length > 0 && { vaultDeletedAt: now }),
					})
					.where(eq(runs.id, id));
				return vaults.length > 0;
			});
			if (vaultDeleted) this.deps.onVaultDeleted(id);
		}
		return due.length;
	}
}
