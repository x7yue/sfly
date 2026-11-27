// 写入时打码的运行（`runs.masked_on_write`，#505）的加密副本：引擎在事务里读写，日志、动作、通知、指标按已提交的那一份打码。
import type { Db, Tx } from "../db/database.js";
import { type SecretSet, secretSetOf } from "../logs/secrets.js";
import type { RunVault, RunVaults } from "./run-vault.js";

/** 引擎的一步（`engine/step.ts` 的 `Step`）里用到的：事务和提交之后的收尾。 */
interface InStep {
	tx: Tx;
	afterCommit: Array<() => void>;
}

const CACHE_RUNS = 1000;

export class RunSecrets {
	readonly #vaults: RunVaults;
	/** 已提交的副本，按运行。 */
	readonly #cache = new Map<string, RunVault>();
	/** 每个运行的副本提交过几次：缓存没命中、从库里读的同时有提交时，读到的旧的那一份不进缓存。 */
	readonly #generations = new Map<string, number>();
	/** 还没提交的事务里写过的副本：同一个事务里接着读到的是它，提交之后才进缓存。 */
	readonly #pending = new WeakMap<Tx, Map<string, RunVault>>();

	constructor(vaults: RunVaults) {
		this.#vaults = vaults;
	}

	/** 这一步里看到的副本：这个事务写过的，否则已提交的。 */
	vault(step: InStep, runId: string): Promise<RunVault> {
		const pending = this.#pending.get(step.tx)?.get(runId);
		return pending ? Promise.resolve(pending) : this.#committed(step.tx, runId);
	}

	/** 在这一步的事务里写回副本；提交之后才换掉缓存里的那一份（回滚了就不换）。 */
	async write(step: InStep, runId: string, vault: RunVault): Promise<void> {
		await this.#vaults.put(step.tx, runId, vault);
		let pending = this.#pending.get(step.tx);
		if (!pending) {
			pending = new Map();
			this.#pending.set(step.tx, pending);
		}
		pending.set(runId, vault);
		step.afterCommit.push(() => {
			this.#generations.set(runId, (this.#generations.get(runId) ?? 0) + 1);
			this.#remember(runId, vault);
		});
	}

	/** 引擎之外的写入（日志、动作、通知、指标）打码用的值集合：已提交的副本里的。 */
	async committedSet(db: Db | Tx, runId: string): Promise<SecretSet> {
		return secretSetOf((await this.#committed(db, runId)).values);
	}

	async #committed(db: Db | Tx, runId: string): Promise<RunVault> {
		const cached = this.#cache.get(runId);
		if (cached) return cached;
		const generation = this.#generations.get(runId);
		const vault = await this.#vaults.get(db, runId);
		if (!vault) throw new Error(`运行 ${runId} 在写入时打码，却没有它的加密副本`);
		if (this.#generations.get(runId) === generation) this.#remember(runId, vault);
		return vault;
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
