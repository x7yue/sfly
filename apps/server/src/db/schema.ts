// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import type { PackageMetadata } from "@sfly/schema";
import { bigint, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** 已发布的节点包版本；`包名@版本` 唯一，发布后不可变。 */
export const nodePackages = pgTable(
	"node_packages",
	{
		name: text("name").notNull(),
		version: text("version").notNull(),
		metadata: jsonb("metadata").$type<PackageMetadata>().notNull(),
		/** 相对控制面数据目录的路径。 */
		filePath: text("file_path").notNull(),
		sha256: text("sha256").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.name, t.version] })],
);
