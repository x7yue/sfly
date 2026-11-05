import { runListApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import { listAllRuns } from "../runs/run-list.js";
import { contractRoute } from "./contract-route.js";

/** 运行记录（契约见 @sfly/schema 的 runListApi）：GET /runs 跨场景的运行列表与筛选。 */
export function registerRunListRoutes(app: FastifyInstance, { db }: { db: Db }): void {
	contractRoute(app, runListApi.list, async ({ query }) =>
		listAllRuns(db, {
			status: query.status,
			orchestrationId: query.orchestration_id,
			q: query.q,
			limit: query.limit,
		}),
	);
}
