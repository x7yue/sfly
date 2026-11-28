// 写入时打码的运行（`runs.masked_on_write`，#505）的加密副本：引擎在事务里读写，日志、动作、通知、指标按已提交的那一份打码；
// 副本删除之后到达的上报丢弃并计数（`runs.late_reports_dropped`）。每个运行一道闸门（{@link Gate}）：上报的准入和写入共享它，
// 删除副本独占它，所以删除不会插在一条上报的准入和写入之间（#862 第 1 轮审查）。
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { runs } from "../db/schema.js";
import { type SecretSet, secretSetOf } from "../logs/secrets.js";
import type { RunVault, RunVaults } from "./run-vault.js";

/** 引擎的一步（`engine/step.ts` 的 `Step`）里用到的：事务和提交之后的收尾。 */
interface InStep {
	tx: Tx;
	afterCommit: Array<() => void>;
}

const CACHE_RUNS = 1000;
const DELETED_RUNS = 10_000;

/**
 * 一个运行的闸门（控制面进程内）：上报（准入加写入）共享，删除副本独占。排着队的删除优先：它之后来的上报等它做完，
 * 上报再多也挡不住删除。拿着闸门的人不等引擎的锁和事务（上报的写入不在引擎的事务里；删除在引擎的事务提交之后另起一个事务），
 * 所以和数据库的锁不会互相等死。控制面只有一个进程（引擎的互斥锁同样只在进程内）。
 */
class Gate {
	#readers = 0;
	#writer = false;
	readonly #queue: Array<{ write: boolean; go: () => void }> = [];

	acquire(write: boolean): Promise<void> {
		const free = write
			? !this.#writer && this.#readers === 0 && this.#queue.length === 0
			: !this.#writer && !this.#queue.some((q) => q.write);
		if (free) {
			this.#take(write);
			return Promise.resolve();
		}
		return new Promise((go) => this.#queue.push({ write, go }));
	}

	release(write: boolean): void {
		if (write) this.#writer = false;
		else this.#readers--;
		while (this.#queue.length > 0) {
			const next = this.#queue[0] as { write: boolean; go: () => void };
			if (this.#writer || (next.write && this.#readers > 0)) break;
			this.#queue.shift();
			this.#take(next.write);
			next.go();
			if (next.write) break;
		}
	}

	get idle(): boolean {
		return !this.#writer && this.#readers === 0 && this.#queue.length === 0;
	}

	#take(write: boolean): void {
		if (write) this.#writer = true;
		else this.#readers++;
	}
}

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
	/** 有人在用或在等的运行的闸门；空闲了就移走。 */
	readonly #gates = new Map<string, Gate>();

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

	/**
	 * 在删除副本的事务里删掉它、记下时刻（`work` 里调用，在 {@link deleting} 的闸门里）；副本已经删了时返回 false。
	 */
	async deleteIn(tx: Tx, runId: string, now: Date): Promise<boolean> {
		const removed = await this.#vaults.delete(tx, runId);
		await tx
			.update(runs)
			.set({ vaultDeletedAt: now })
			.where(and(eq(runs.id, runId), isNull(runs.vaultDeletedAt)));
		return removed;
	}

	/**
	 * 独占这个运行的闸门做删除副本的事务（`work`，它提交了才返回）：进行中的上报先做完，之后来的等它做完；`work` 说删了，
	 * 提交之后、放开闸门之前记下已删除，之后的上报一律丢弃。引擎的一步（`engine/released.ts`）在提交之后调用它，
	 * 保留期清理在清理运行的事务外面调用它。
	 */
	async deleting(runId: string, work: () => Promise<boolean>): Promise<boolean> {
		return this.#gated(runId, true, async () => {
			const deleted = await work();
			if (deleted) {
				this.#bump(runId);
				this.#cache.delete(runId);
				this.#markDeleted(runId);
			}
			return deleted;
		});
	}

	/**
	 * 引擎之外的写入（日志、进度、动作、通知、指标）的准入：副本还在，拿着闸门用已提交的副本里的值集合做 `write`（写入在里面做完）；
	 * 已经删除，这条上报丢弃，计一条（`runs.late_reports_dropped`），返回 undefined。删除副本等 `write` 做完才开始。
	 */
	admitted<T>(
		db: Db | Tx,
		runId: string,
		write: (secrets: SecretSet) => Promise<T>,
	): Promise<T | undefined> {
		return this.#gated(runId, false, async () => {
			const set = await this.committedSet(db, runId);
			if (!set) {
				await this.countDropped(db, runId);
				return undefined;
			}
			return write(set);
		});
	}

	async #gated<T>(runId: string, write: boolean, work: () => Promise<T>): Promise<T> {
		let gate = this.#gates.get(runId);
		if (!gate) {
			gate = new Gate();
			this.#gates.set(runId, gate);
		}
		await gate.acquire(write);
		try {
			return await work();
		} finally {
			gate.release(write);
			if (gate.idle && this.#gates.get(runId) === gate) this.#gates.delete(runId);
		}
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
