// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
