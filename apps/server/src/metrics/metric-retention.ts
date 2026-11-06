import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { metricSeries, runs } from "../db/schema.js";

/** 指标的默认保留期：30 天（与日志、产物的保留期分开配置）。 */
export const DEFAULT_METRIC_RETENTION_DAYS = 30;
/** 除了今天，提前创建之后几天的分区。 */
export const PARTITION_DAYS_AHEAD = 2;

const DAY_MS = 86_400_000;
/** 每次扫描最多判定过期的运行数（剩下的下次扫描继续）。 */
const BATCH = 100;
const PARENT = "metric_segments";
const PARTITION_NAME = /^metric_segments_(\d{4})(\d{2})(\d{2})$/;

/**
 * 指标保留期与分区维护（#32，ADR 0009）：`metric_segments` 按天（UTC）分区。
 *
 * - 周期扫描（与日志、产物的保留期清理共用）提前创建今天和之后 {@link PARTITION_DAYS_AHEAD} 天的分区，
 *   并删除整天都早于「现在 − 保留期」的分区；是否到期只按注入的时钟判断。
 * - 接收的点只接受时间戳落在「现在 − 保留期」到最后一个提前创建的分区结束之间的（{@link accepts}）：
 *   点的时间来自 Agent 的时钟，时钟异常时不会按异常的日期建分区。这个范围内、还不存在的过去日期的分区
 *   （例如 Agent 断线期间排队的点）在写入时按需创建（{@link ensurePartition}）。
 * - 运行结束超过保留期后判定为「已过保留期」：删除它的指标摘要（`metric_series`），记下 `runs.metrics_purged_at`，
 *   摘要、目录、序列接口据此返回已过保留期（{@link isExpired}），之后迟到的点直接丢弃、不再写回。
 *   它的原始数据随所在的整天分区删除（最晚再过一天），在此之前也不再对外提供。
 * - 运行的数据只要有一部分被删除，它就是「已过保留期」：删除分区时，在同一个事务里把在这个分区里有数据的运行
 *   一并标记（跨天的运行开头几天先到期时，不会出现没有提示的空洞）；内存里还没写库的段若落在已整天过期的日期
 *   （{@link dayExpired}，与删除分区同一判定），写入时不再重建分区，而是同样把运行标记为已过保留期（见 TaskMetrics）。
 * - 已知存在的分区缓存在内存里；删除分区时同时移出缓存。分区被别处删除时，写入失败后调用
 *   {@link forgetPartitions} 再重试。
 */
export class MetricRetention {
	#partitions = new Map<number, Promise<void>>();
	#sweeping: Promise<void> | undefined;

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 保留天数，默认 {@link DEFAULT_METRIC_RETENTION_DAYS}。 */
			retentionDays?: number;
		},
	) {}

	get retentionMs(): number {
		return (this.deps.retentionDays ?? DEFAULT_METRIC_RETENTION_DAYS) * DAY_MS;
	}

	/** Unix 秒 t 的点是否在可接收的时间范围内。 */
	accepts(t: number): boolean {
		const now = this.deps.clock.now().getTime();
		const ms = t * 1000;
		return ms >= now - this.retentionMs && ms < dayOf(now) + (PARTITION_DAYS_AHEAD + 1) * DAY_MS;
	}

	/** Unix 秒 t 所在那一天（UTC）是否整天早于「现在 − 保留期」：这天的分区已经（或将被）扫描删除。 */
	dayExpired(t: number): boolean {
		return this.#dayExpired(dayOf(t * 1000), this.deps.clock.now().getTime());
	}

	#dayExpired(day: number, now: number): boolean {
		return day + DAY_MS <= now - this.retentionMs;
	}

	/** 确保 Unix 秒 t 所在那一天（UTC）的分区存在。 */
	ensurePartition(t: number): Promise<void> {
		return this.#ensure(dayOf(t * 1000));
	}

	/** 忘掉这些 Unix 秒所在日期的分区（写入因分区不存在而失败时），下次写入前重新创建。 */
	forgetPartitions(times: number[]): void {
		for (const t of times) this.#partitions.delete(dayOf(t * 1000));
	}

	/** 运行的指标是否已过保留期。 */
	async isExpired(runId: string): Promise<boolean> {
		const [row] = await this.deps.db
			.select({ id: runs.id })
			.from(runs)
			.where(and(eq(runs.id, runId), isNotNull(runs.metricsPurgedAt)));
		return row !== undefined;
	}

	/** 提前创建分区、删除过期分区、判定过期的运行；上一次扫描还没结束时等它结束。 */
	sweep(): Promise<void> {
		this.#sweeping ??= this.#sweep().finally(() => {
			this.#sweeping = undefined;
		});
		return this.#sweeping;
	}

	/** 等正在进行的扫描结束（关闭控制面前调用）。 */
	async idle(): Promise<void> {
		await this.#sweeping?.catch(() => {});
	}

	async #sweep(): Promise<void> {
		const now = this.deps.clock.now().getTime();
		for (let i = 0; i <= PARTITION_DAYS_AHEAD; i++) await this.#ensure(dayOf(now) + i * DAY_MS);
		const cutoff = now - this.retentionMs;
		const { rows } = await this.deps.db.execute<{ name: string }>(sql`
			select c.relname as name from pg_inherits i
				join pg_class c on c.oid = i.inhrelid
				join pg_class p on p.oid = i.inhparent
			where p.relname = ${PARENT}`);
		for (const { name } of rows) {
			const day = parseDay(name);
			if (day === undefined || !this.#dayExpired(day, now)) continue;
			this.#partitions.delete(day);
			await this.deps.db.transaction(async (tx) => {
				// 先锁住分区（之后不会再有写入），把在这里有数据的运行标为已过保留期，再删除分区。
				await tx.execute(sql.raw(`lock table "${name}" in access exclusive mode`));
				const { rows: affected } = await tx.execute<{ run_id: string }>(
					sql.raw(`select distinct run_id from "${name}"`),
				);
				await purgeRunMetrics(
					tx,
					affected.map((r) => r.run_id),
					new Date(now),
				);
				await tx.execute(sql.raw(`drop table "${name}"`));
			});
		}
		const due = await this.deps.db
			.select({ id: runs.id })
			.from(runs)
			.where(and(isNull(runs.metricsPurgedAt), lt(runs.endedAt, new Date(cutoff))))
			.limit(BATCH);
		if (due.length === 0) return;
		const ids = due.map((r) => r.id);
		await this.deps.db.transaction((tx) => purgeRunMetrics(tx, ids, new Date(now)));
	}

	#ensure(day: number): Promise<void> {
		let created = this.#partitions.get(day);
		if (!created) {
			const from = new Date(day);
			const to = new Date(day + DAY_MS);
			created = this.deps.db
				.execute(
					sql.raw(
						`create table if not exists "${partitionName(day)}" partition of ${PARENT} ` +
							`for values from ('${from.toISOString()}') to ('${to.toISOString()}') ` +
							"with (toast_tuple_target = 128)",
					),
				)
				.then(() => {});
			this.#partitions.set(day, created);
			const pending = created;
			pending.catch(() => {
				if (this.#partitions.get(day) === pending) this.#partitions.delete(day);
			});
		}
		return created;
	}
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 把这些运行标记为指标已过保留期并删除它们的摘要（已标记的不变）。先标记再删摘要：写入指标时会锁住运行这一行
 * 并检查标记（见 TaskMetrics），这样不会有迟到的点写回。
 */
export async function purgeRunMetrics(tx: Tx, ids: string[], at: Date): Promise<void> {
	if (ids.length === 0) return;
	await tx
		.update(runs)
		.set({ metricsPurgedAt: at })
		.where(and(inArray(runs.id, ids), isNull(runs.metricsPurgedAt)));
	await tx.delete(metricSeries).where(inArray(metricSeries.runId, ids));
}

/** 毫秒时间戳所在那一天（UTC）的零点。 */
function dayOf(ms: number): number {
	return Math.floor(ms / DAY_MS) * DAY_MS;
}

function partitionName(day: number): string {
	return `${PARENT}_${new Date(day).toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function parseDay(name: string): number | undefined {
	const m = PARTITION_NAME.exec(name);
	return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}
