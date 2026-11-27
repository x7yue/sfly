// 写入时打码的运行（`runs.masked_on_write`，#505）的加密副本：引擎在事务里读写，日志、动作、通知、指标按已提交的那一份打码；
// 副本删除之后到达的上报丢弃并计数（`runs.late_reports_dropped`）。
import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { runs } from "../db/schema.js";
import { type SecretSet, secretSetOf } from "../logs/secrets.js";
import type { RunVault, RunVaults } from "./run-vault.js";

/** 引擎的一步（`engine/step.ts` 的 `Step`）里用到的：事务、此刻和提交之后的收尾。 */
interface InStep {
	tx: Tx;
	now: Date;
	afterCommit: Array<() => void>;
}

const CACHE_RUNS = 1000;
const DELETED_RUNS = 10_000;

export class RunSecrets {
	readonly #vaults: RunVaults;
	/** 已提交的副本，按运行。 */
	readonly #cache = new Map<string, RunVault>();
	/** 副本已经删除的运行。 */
	readonly #deleted = new Set<string>();
	/** 每个运行的副本提交过几次：缓存没命中、从库里读的同时有提交时，读到的旧的那一份不进缓存。 */
	readonly #generations = new Map<string, number>();
	/** 还没提交的事务里写过的副本：同一个事务里接着读到的是它，提交之后才进缓存。 */
	readonly #pending = new WeakMap<Tx, Map<string, RunVault>>();

	constructor(vaults: RunVaults) {
		this.#vaults = vaults;
	}

	/** 这一步里看到的副本：这个事务写过的，否则已提交的。副本已经删除时抛出：引擎不会再为这个运行写库。 */
	async vault(step: InStep, runId: string): Promise<RunVault> {
		const vault = this.#pending.get(step.tx)?.get(runId) ?? (await this.#committed(step.tx, runId));
		if (!vault) throw new Error(`运行 ${runId} 的加密副本已经删除，不能再为它写库`);
		return vault;
	}

	/** 在这一步的事务里写回副本；提交之后才换掉缓存里的那一份（回滚了就不换）。 */
	async write(step: InStep, runId: string, vault: RunVault): Promise<void> {
		await this.#vaults.put(step.tx, runId, vault);
		this.#stage(step, runId, vault);
		step.afterCommit.push(() => {
			this.#bump(runId);
			this.#remember(runId, vault);
		});
	}

	/** 删除副本（运行结束、每次尝试都已离开 Agent 之手，`engine/released.ts`），记下时刻；提交之后迟到的上报一律丢弃。 */
	async delete(step: InStep, runId: string): Promise<void> {
		await this.#vaults.delete(step.tx, runId);
		await step.tx.update(runs).set({ vaultDeletedAt: step.now }).where(eq(runs.id, runId));
		step.afterCommit.push(() => this.forget([runId]));
	}

	/** 这些运行的副本已经在别处删除（保留期清理）。 */
	forget(runIds: readonly string[]): void {
		for (const runId of runIds) {
			this.#bump(runId);
			this.#cache.delete(runId);
			this.#markDeleted(runId);
		}
	}

	/**
	 * 引擎之外的写入（日志、进度、动作、通知、指标）的准入和打码用的值集合：副本还在，返回已提交的副本里的值集合；
	 * 已经删除，这条上报丢弃，计一条（`runs.late_reports_dropped`），返回 undefined。
	 */
	async admit(db: Db | Tx, runId: string): Promise<SecretSet | undefined> {
		const set = await this.committedSet(db, runId);
		if (!set) await this.countDropped(db, runId);
		return set;
	}

	/** 已提交的副本里的值集合；副本已经删除时是 undefined（不计数）。 */
	async committedSet(db: Db | Tx, runId: string): Promise<SecretSet | undefined> {
		const vault = await this.#committed(db, runId);
		return vault && secretSetOf(vault.values);
	}

	/** 副本删除之后到达的一条上报被丢弃了。 */
	async countDropped(db: Db | Tx, runId: string): Promise<void> {
		await db
			.update(runs)
			.set({ lateReportsDropped: sql`${runs.lateReportsDropped} + 1` })
			.where(eq(runs.id, runId));
	}

	/** 副本删了没有（迟到的结果计数用）。 */
	async deleted(db: Db | Tx, runId: string): Promise<boolean> {
		return (await this.#committed(db, runId)) === undefined;
	}

	#stage(step: InStep, runId: string, vault: RunVault): void {
		let pending = this.#pending.get(step.tx);
		if (!pending) {
			pending = new Map();
			this.#pending.set(step.tx, pending);
		}
		pending.set(runId, vault);
	}

	/** 已提交的副本；已经删除时是 undefined。 */
	async #committed(db: Db | Tx, runId: string): Promise<RunVault | undefined> {
		if (this.#deleted.has(runId)) return undefined;
		const cached = this.#cache.get(runId);
		if (cached) return cached;
		const generation = this.#generations.get(runId);
		const vault = await this.#vaults.get(db, runId);
		if (!vault) {
			const [run] = await db
				.select({ deletedAt: runs.vaultDeletedAt })
				.from(runs)
				.where(eq(runs.id, runId));
			if (run?.deletedAt == null) {
				throw new Error(`运行 ${runId} 在写入时打码，却没有它的加密副本`);
			}
			this.#markDeleted(runId);
			return undefined;
		}
		if (this.#generations.get(runId) === generation) this.#remember(runId, vault);
		return vault;
	}

	/** 记下副本已删除的运行，最多 {@link DELETED_RUNS} 个（更早的再问时查库）。 */
	#markDeleted(runId: string): void {
		this.#deleted.delete(runId);
		this.#deleted.add(runId);
		if (this.#deleted.size > DELETED_RUNS) {
			const oldest = this.#deleted.values().next().value;
			if (oldest !== undefined) this.#deleted.delete(oldest);
		}
	}

	#bump(runId: string): void {
		this.#generations.set(runId, (this.#generations.get(runId) ?? 0) + 1);
	}

	#remember(runId: string, vault: RunVault): void {
		this.#cache.delete(runId);
		this.#cache.set(runId, vault);
		if (this.#cache.size > CACHE_RUNS) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
	}
}
