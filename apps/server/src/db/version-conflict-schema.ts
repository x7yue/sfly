// 因为同一台 Agent 上同一个节点包的另一个版本正在执行而被拒的记录（#449）：触发时预检阻断的、派发时失败的各一行。
// 以后据它判断要不要做「每个版本一个环境」。只增不改，没有外键：运行清理掉之后记录还在。
import { sql } from "drizzle-orm";
import { bigserial, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const packageVersionConflicts = pgTable(
	"package_version_conflicts",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
		/** `trigger`：触发前的预检阻断；`dispatch`：派发时任务失败。 */
		stage: text("stage").$type<"trigger" | "dispatch">().notNull(),
		/** 被拒的场景所在的项目。 */
		projectId: text("project_id").notNull(),
		agentName: text("agent_name").notNull(),
		package: text("package").notNull(),
		/** 被拒的那个版本。 */
		version: text("version").notNull(),
		/** 给用户的说明（含正在执行的是哪个版本、哪次运行）。 */
		message: text("message").notNull(),
	},
	(t) => [
		check("package_version_conflicts_stage", sql`${t.stage} in ('trigger', 'dispatch')`),
		index("package_version_conflicts_at").on(t.at),
	],
);
