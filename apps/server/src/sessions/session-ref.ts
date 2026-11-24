import type { SessionRef } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { sessions } from "../db/schema.js";

/**
 * 运行、场景版本上记的会话（`runs.session_id`、`orchestration_versions.session_id`）对应的会话 ID 和标题：
 * 按 ID 批量取，没有会话的（空）不查。标题是会话此刻的标题。
 */
export async function sessionRefs(
	db: Db | Tx,
	ids: ReadonlyArray<string | null>,
): Promise<Map<string, SessionRef>> {
	const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
	if (wanted.length === 0) return new Map();
	const rows = await db
		.select({ id: sessions.id, title: sessions.title })
		.from(sessions)
		.where(inArray(sessions.id, wanted));
	return new Map(rows.map((row) => [row.id, { id: row.id, title: row.title }]));
}

/** 有会话时带上它的 `session` 字段（不是会话做的响应里没有这个字段）。 */
export const withSession = (ref: SessionRef | undefined): { session?: SessionRef } =>
	ref === undefined ? {} : { session: ref };
