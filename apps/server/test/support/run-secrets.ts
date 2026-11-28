import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunSecrets } from "../../src/secrets/run-secrets.js";
import { RunVaults } from "../../src/secrets/run-vault.js";
import { VAULT_KEY_FILE } from "../../src/secrets/vault-key.js";

/** 测试里自己建的 TaskLogs 等要读这个控制面的运行的加密副本时用：同一把钥匙（数据目录里的钥匙文件）。 */
export async function runSecretsOf(dataDir: string): Promise<RunSecrets> {
	return new RunSecrets(new RunVaults(await readFile(join(dataDir, VAULT_KEY_FILE))));
}
