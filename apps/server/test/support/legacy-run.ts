import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { openDatabase } from "../../src/db/database.js";
import { RunVaults } from "../../src/secrets/run-vault.js";
import { VAULT_KEY_FILE } from "../../src/secrets/vault-key.js";
import { ApiClient } from "./api-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 把刚触发的运行改成写入时打码（#505）之前的样子：参数和输出里放回加密副本里的原值、去掉标记和副本。
 * 「没有标记的运行照旧在读取时打码」的用例用它；在 Agent 上报任何东西之前调用（控制面按运行缓存标记）。
 */
export async function asLegacyRun(cp: TestControlPlane, runId: string): Promise<void> {
	const vaults = new RunVaults(await readFile(join(cp.dataDir, VAULT_KEY_FILE)));
	const opened = openDatabase(cp.database.url, () => {});
	const vault = await opened.db
		.transaction((tx) => vaults.get(tx, runId))
		.finally(() => opened.close());
	if (!vault) throw new Error(`运行 ${runId} 没有加密副本`);
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query("begin");
		for (const [chain, raw] of Object.entries(vault.params)) {
			await client.query("update chain_instances set params = params || $2::jsonb where id = $1", [
				chain,
				JSON.stringify(raw),
			]);
		}
		await client.query(
			`update runs set masked_on_write = false, params = (select params from chain_instances where run_id = $1 and depth = 0)
			where id = $1`,
			[runId],
		);
		for (const [task, raw] of Object.entries(vault.outputs)) {
			await client.query("update tasks set outputs = $2::jsonb where id = $1", [
				task,
				JSON.stringify(raw),
			]);
		}
		await client.query("delete from run_vaults where run_id = $1", [runId]);
		await client.query("commit");
	} finally {
		await client.end();
	}
}

/** 触发出来的运行都改成写入时打码之前的样子（{@link asLegacyRun}）的 API 客户端。 */
export class LegacyRunsApi extends ApiClient {
	constructor(private readonly plane: TestControlPlane) {
		super(plane);
	}

	override async triggerOk(
		orchestrationId: string,
		params: Record<string, unknown> = {},
	): Promise<string> {
		const runId = await super.triggerOk(orchestrationId, params);
		await asLegacyRun(this.plane, runId);
		return runId;
	}
}
