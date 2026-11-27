// 加密运行副本的钥匙（#505，ADR 0029「密钥」）：数据目录里只有属主可读的文件，库里只记指纹，对不上就拒绝启动。
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/database.js";
import { runVaults, vaultKey } from "../db/vault-schema.js";

export const VAULT_KEY_FILE = "secrets.key";
const KEY_BYTES = 32;

/** 钥匙文件和库对不上时启动失败的说明：写明是哪个文件、怎么了、怎么恢复。 */
export class VaultKeyError extends Error {
	override readonly name = "VaultKeyError";
}

const fingerprintOf = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 32);

const RESTORE = "从备份放回原来的钥匙文件（它要和数据库分开备份）后再启动";

/** 读出（或首次生成）钥匙，并和库里记的指纹对照。 */
export async function openVaultKey(dataDir: string, db: Db): Promise<Buffer> {
	const file = join(dataDir, VAULT_KEY_FILE);
	const [recorded] = await db.select().from(vaultKey);
	const key = await readKey(file);
	if (key === undefined) {
		if (recorded !== undefined) {
			throw new VaultKeyError(
				`钥匙文件 ${file} 不见了：库里记着用它加密过，没有它读不出加密的运行副本。${RESTORE}`,
			);
		}
		const created = randomBytes(KEY_BYTES);
		// `wx`：已经有了就失败，不覆盖。
		await writeFile(file, created, { mode: 0o600, flag: "wx" });
		await db.insert(vaultKey).values({ fingerprint: fingerprintOf(created) });
		return created;
	}
	const fingerprint = fingerprintOf(key);
	if (recorded === undefined) {
		const [sealed] = await db.select({ runId: runVaults.runId }).from(runVaults).limit(1);
		if (sealed !== undefined) {
			throw new VaultKeyError(
				`钥匙文件 ${file} 和数据库对不上：库里有加密的运行副本，却没有记下钥匙。数据库和数据目录要是同一套部署的；${RESTORE}`,
			);
		}
		await db.insert(vaultKey).values({ fingerprint });
		return key;
	}
	if (recorded.fingerprint !== fingerprint) {
		throw new VaultKeyError(
			`钥匙文件 ${file} 被换过：和库里记下的钥匙不是同一个，用它读不出加密的运行副本。${RESTORE}`,
		);
	}
	return key;
}

async function readKey(file: string): Promise<Buffer | undefined> {
	let mode: number;
	try {
		mode = (await stat(file)).mode;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if ((mode & 0o077) !== 0) {
		throw new VaultKeyError(
			`钥匙文件 ${file} 别的用户也能访问（权限 ${(mode & 0o777).toString(8)}）：运行 chmod 600 ${file} 后再启动`,
		);
	}
	const key = await readFile(file);
	if (key.length !== KEY_BYTES) {
		throw new VaultKeyError(
			`钥匙文件 ${file} 不是 ${KEY_BYTES} 字节（是 ${key.length} 字节），不是控制面生成的那一个。${RESTORE}`,
		);
	}
	return key;
}
