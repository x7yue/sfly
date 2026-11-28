// 运行的加密副本（#505，ADR 0029「密钥」）：AES-256-GCM，附加数据是运行 ID，一个运行的副本挪到别的运行上解不开。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { runVaults } from "../db/vault-schema.js";

/** 副本的内容：原值集合、secret 参数的原值（按链实例 ID）、和打码后不一样的原样输出（按任务 ID）。 */
export interface RunVault {
	values: unknown[];
	params: Record<string, Record<string, unknown>>;
	outputs: Record<string, Record<string, unknown>>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 副本解不开：钥匙不对，或者副本被改过、挪过。 */
export class RunVaultError extends Error {
	override readonly name = "RunVaultError";
}

export function sealRunVault(key: Buffer, runId: string, vault: RunVault): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(runId));
	const body = Buffer.concat([cipher.update(JSON.stringify(vault), "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function openRunVault(key: Buffer, runId: string, sealed: Buffer): RunVault {
	const broken = () =>
		new RunVaultError(`运行 ${runId} 的加密副本解不开：钥匙不对，或者副本被改过、截断过`);
	if (sealed.length < IV_BYTES + TAG_BYTES) throw broken();
	let text: string;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(runId));
		decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		text = Buffer.concat([
			decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
			decipher.final(),
		]).toString("utf8");
	} catch {
		throw broken();
	}
	return JSON.parse(text) as RunVault;
}

/** 在库里存取运行的加密副本；和引起它变化的那次写库用同一个事务。 */
export class RunVaults {
	readonly #key: Buffer;

	constructor(key: Buffer) {
		this.#key = key;
	}

	async get(db: Db | Tx, runId: string): Promise<RunVault | undefined> {
		const [row] = await db
			.select({ sealed: runVaults.sealed })
			.from(runVaults)
			.where(eq(runVaults.runId, runId));
		return row && openRunVault(this.#key, runId, row.sealed);
	}

	async put(tx: Tx, runId: string, vault: RunVault): Promise<void> {
		const sealed = sealRunVault(this.#key, runId, vault);
		await tx
			.insert(runVaults)
			.values({ runId, sealed })
			.onConflictDoUpdate({ target: runVaults.runId, set: { sealed } });
	}

	/** 删除副本；没有这个运行的副本时返回 false。 */
	async delete(tx: Tx, runId: string): Promise<boolean> {
		const removed = await tx
			.delete(runVaults)
			.where(eq(runVaults.runId, runId))
			.returning({ runId: runVaults.runId });
		return removed.length > 0;
	}
}
