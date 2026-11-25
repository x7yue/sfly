import type { StoredOrchestrationDocument } from "@sfly/schema";
import { and, asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { orchestrations, orchestrationVersions, runPresets } from "../db/schema.js";

/**
 * 预检里按默认值、运行预设的值算的警告要看真正的值：读场景最新版本的原始文档（secret 参数的默认值是明文，没有版本时 undefined）
 * 和运行预设的原始值（按名称排序，带 ID）。不经过打码的读取函数（路由层拿不到原始文档，biome-plugins/raw-version-document.grit）。
 * 一次预检只读一次：路由读出来传给各项检查（预设的值可以很大，不能每项检查各读一遍）。
 */
export interface RawScenario {
	document: StoredOrchestrationDocument;
	presets: Array<{ id: string; name: string; values: Record<string, unknown> }>;
}

export async function rawScenario(
	db: Db | Tx,
	orchestrationId: string,
): Promise<RawScenario | undefined> {
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
	if (!head) return undefined;
	const presets = await db
		.select({ id: runPresets.id, name: runPresets.name, values: runPresets.values })
		.from(runPresets)
		.where(eq(runPresets.orchestrationId, orchestrationId))
		.orderBy(asc(runPresets.name));
	return { document: head.document, presets };
}
