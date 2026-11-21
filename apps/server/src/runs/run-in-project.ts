import type { RunView } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { runs } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { getRunView } from "./run-read.js";

/**
 * 按 ID 取这个项目里的运行视图；运行不存在或属于别的项目时返回 undefined（和不存在一样，不透露别的项目里有它）。
 * 运行的 `project_id` 和它的场景一致，按运行 ID 定位的接口据此得出项目（ADR 0029「项目从请求的哪里来」）。
 * 不改 `run-read.ts` 的读取：先按项目确认运行在这个项目里，再用同一个读取。
 */
export async function getRunViewInProject(
	db: Db | Tx,
	project: ProjectId,
	runId: string,
): Promise<RunView | undefined> {
	const [row] = await db
		.select({ id: runs.id })
		.from(runs)
		.where(and(eq(runs.id, runId), eq(runs.projectId, project)));
	return row && getRunView(db, runId);
}
