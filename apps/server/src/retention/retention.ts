import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { artifacts, runs } from "../db/schema.js";

/** 日志和产物的默认保留期：30 天。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 每次清理最多处理的运行数（剩下的下次扫描继续）。 */
const BATCH = 100;

/**
 * 日志和产物的保留期清理（#18）：运行结束超过保留期后，删除它的日志目录 `logs/<run_id>/`、
 * 产物目录 `artifacts/<run_id>/` 和产物记录，并在 `runs.purged_at` 记下清理时间。
 * 运行本身、任务状态和输出都保留。是否到期只按注入的时钟判断，测试推进手动时钟即可。
 */
export class Retention {
	#sweeping: Promise<number> | undefined;

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			dataDir: string;
			/** 保留天数，默认 {@link DEFAULT_RETENTION_DAYS}。 */
			retentionDays?: number;
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

	async #sweep(): Promise<number> {
		const now = this.deps.clock.now();
		const cutoff = new Date(now.getTime() - this.retentionMs);
		const due = await this.deps.db
			.select({ id: runs.id })
			.from(runs)
			.where(and(isNull(runs.purgedAt), lt(runs.endedAt, cutoff)))
			.limit(BATCH);
		for (const { id } of due) {
			// 先删文件再标记：中途出错时下一次扫描会重新处理（删除是幂等的）。
			await Promise.all(
				["logs", "artifacts"].map((dir) =>
					rm(join(this.deps.dataDir, dir, id), { recursive: true, force: true }),
				),
			);
			await this.deps.db.transaction(async (tx) => {
				await tx.delete(artifacts).where(eq(artifacts.runId, id));
				await tx.update(runs).set({ purgedAt: now }).where(eq(runs.id, id));
			});
		}
		return due.length;
	}
}
