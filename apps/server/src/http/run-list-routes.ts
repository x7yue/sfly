import { runListApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import { pathProject } from "../projects/project-id.js";
import { listAllRuns } from "../runs/run-list.js";
import { contractRoute } from "./contract-route.js";

/** 运行记录（契约见 @sfly/schema 的 runListApi）：`GET /projects/:project/runs` 项目里跨场景的运行列表与筛选（#488）。 */
export function registerRunListRoutes(app: FastifyInstance, { db }: { db: Db }): void {
	contractRoute(app, runListApi.list, async ({ params, query }) =>
		// 按场景筛选：运行记着自己的项目（和场景的项目相同），别的项目的场景筛出来是空的。
		listAllRuns(db, pathProject(params), {
			status: query.status,
			orchestrationId: query.orchestration_id,
			q: query.q,
			triggeredBy: query.triggered_by,
			idPrefix: query.id_prefix,
			sessionId: query.session_id,
			limit: query.limit,
		}),
	);
}
