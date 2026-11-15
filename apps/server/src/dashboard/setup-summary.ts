import type { DashboardSetup } from "@sfly/schema";
import { asc, count, countDistinct, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents, nodePackages, orchestrations, runs } from "../db/schema.js";

/**
 * 控制台「开始使用」的四步（契约见 @sfly/schema 的 DashboardSetup）：每一步都从现有的表判断，
 * 不依赖统计窗口，也不用把 Agent 的槽位和任务读一遍。
 */
export async function setupSummary(db: Db): Promise<DashboardSetup> {
	const [online, packageTotal, latestPackage, scenarioTotal, latestScenario, firstRun] =
		await Promise.all([
			db
				.select({ name: agents.name })
				.from(agents)
				.where(eq(agents.status, "online"))
				.orderBy(asc(agents.name)),
			db.select({ n: countDistinct(nodePackages.name) }).from(nodePackages),
			db
				.select({ name: nodePackages.name, version: nodePackages.version })
				.from(nodePackages)
				.orderBy(desc(nodePackages.publishedAt), asc(nodePackages.name), desc(nodePackages.version))
				.limit(1),
			db.select({ n: count() }).from(orchestrations).where(isNull(orchestrations.archivedAt)),
			db
				.select({ name: orchestrations.name })
				.from(orchestrations)
				.where(isNull(orchestrations.archivedAt))
				.orderBy(desc(orchestrations.createdAt), desc(orchestrations.id))
				.limit(1),
			db.select({ id: runs.id }).from(runs).limit(1),
		]);
	const packages = packageTotal[0]?.n ?? 0;
	const scenarios = scenarioTotal[0]?.n ?? 0;
	return {
		agent: { done: online.length > 0, online: online.length, name: online[0]?.name ?? null },
		package: { done: packages > 0, count: packages, latest: latestPackage[0] ?? null },
		scenario: { done: scenarios > 0, count: scenarios, name: latestScenario[0]?.name ?? null },
		run: { done: firstRun.length > 0 },
	};
}
