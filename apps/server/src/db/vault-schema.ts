// 运行的加密副本和加密它的钥匙的指纹（#505，ADR 0029「密钥」）：钥匙本身在数据目录的文件里，不在库里。
import { sql } from "drizzle-orm";
import { check, customType, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { runs } from "./schema.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** 数据目录里钥匙文件的指纹，只有一行：启动时和文件对照，丢了或换了就拒绝启动（`secrets/vault-key.ts`）。 */
export const vaultKey = pgTable(
	"vault_key",
	{
		id: smallint("id").primaryKey().default(1),
		fingerprint: text("fingerprint").notNull(),
	},
	(t) => [check("vault_key_single", sql`${t.id} = 1`)],
);

/** 运行的加密副本（`secrets/run-vault.ts`）：原值集合、保密参数的原值、原样输出；运行删除时一起删。 */
export const runVaults = pgTable("run_vaults", {
	runId: uuid("run_id")
		.primaryKey()
		.references(() => runs.id, { onDelete: "cascade" }),
	sealed: bytea("sealed").notNull(),
});
