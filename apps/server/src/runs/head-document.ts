import type { StoredOrchestrationDocument } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { orchestrations, orchestrationVersions } from "../db/schema.js";

/**
 * 场景最新版本的原始文档（secret 参数的默认值是明文）；场景没有保存过版本时 undefined。
 * 只给预检里按默认值算的警告用，那里要看真正的值，不经过打码的读取函数（路由层拿不到原始文档，biome-plugins/raw-version-document.grit）。
 */
export async function rawHeadDocument(
	db: Db | Tx,
	orchestrationId: string,
): Promise<StoredOrchestrationDocument | undefined> {
	const [head] = await db
		.select({ document: orchestrationVersions.document })
		.from(orchestrations)
		.innerJoin(
			orchestrationVersions,
			and(
				eq(orchestrationVersions.orchestrationId, orchestrations.id),
				eq(orchestrationVersions.number, orchestrations.headVersion),
			),
		)
		.where(eq(orchestrations.id, orchestrationId));
	return head?.document;
}
