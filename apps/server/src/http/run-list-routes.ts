import { runListApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";
import { listAllRuns } from "../runs/run-list.js";
import { contractRoute } from "./contract-route.js";

/** 运行记录（契约见 @sfly/schema 的 runListApi）：GET /runs 跨场景的运行列表与筛选。路径还不带项目（#488）：默认项目。 */
export function registerRunListRoutes(app: FastifyInstance, { db }: { db: Db }): void {
	contractRoute(app, runListApi.list, async ({ query }) =>
		listAllRuns(db, DEFAULT_PROJECT, {
			status: query.status,
			orchestrationId: query.orchestration_id,
			q: query.q,
			triggeredBy: query.triggered_by,
			idPrefix: query.id_prefix,
			limit: query.limit,
		}),
	);
}
