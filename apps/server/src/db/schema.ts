// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import type { OrchestrationDocument } from "@sfly/schema";
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Agent 上报的信息（Hello）。 */
export interface AgentInfo {
	agent_version: string;
	os: string;
	arch: string;
	slots: number;
}

export type AgentStatus = "online" | "offline";

/** Agent：按名称唯一；第一次 Hello 时注册，之后每次连接更新信息。 */
export const agents = pgTable("agents", {
	name: text("name").primaryKey(),
	info: jsonb("info").$type<AgentInfo>().notNull(),
	status: text("status").$type<AgentStatus>().notNull(),
	registeredAt: timestamptz("registered_at").notNull(),
	lastSeenAt: timestamptz("last_seen_at").notNull(),
});

/** 编排：记录当前最新版本号（0 表示还没有保存过版本）。 */
export const orchestrations = pgTable("orchestrations", {
	id: uuid("id").primaryKey(),
	name: text("name").notNull(),
	headVersion: integer("head_version").notNull().default(0),
	createdAt: timestamptz("created_at").notNull(),
});

/** 编排版本：不可变，同一编排内编号唯一、递增。 */
export const orchestrationVersions = pgTable(
	"orchestration_versions",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		number: integer("number").notNull(),
		document: jsonb("document").$type<OrchestrationDocument>().notNull(),
		author: text("author").notNull(),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [unique("orchestration_versions_number").on(t.orchestrationId, t.number)],
);
