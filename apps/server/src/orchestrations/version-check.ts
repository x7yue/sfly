import { diffDocuments } from "@sfly/orchestration";
import type {
	DocumentDiffView,
	DocumentWarningView,
	StoredOrchestrationDocument,
} from "@sfly/schema";
import type { Db } from "../db/database.js";
import { presetInvalidatedWarnings } from "../presets/preset-invalidation.js";
import { checkDocument } from "./document-checks.js";
import { secretDefaultWarnings } from "./secret-defaults.js";

/**
 * 一份即将成为（或已经成为）场景新版本的文档的警告，保存、恢复和检查（#424）共用这一处：
 * 文档的静态检查，加上会让运行预设失效的改动，以及 secret 参数写了默认值的提醒（只提醒，不阻止保存）。
 * `document` 是新版本的文档、`previous` 是它的上一个版本（第一个版本没有），都是打码后的：这几项检查都不看 secret 默认值的内容。
 */
export async function versionWarnings(
	db: Db,
	orchestrationId: string,
	document: StoredOrchestrationDocument,
	previous: StoredOrchestrationDocument | undefined,
): Promise<DocumentWarningView[]> {
	return [
		...(await checkDocument(db, document)),
		...(await presetInvalidatedWarnings(db, orchestrationId, previous, document)),
		...secretDefaultWarnings(document),
	];
}

/**
 * 两份场景文档的差异：@sfly/orchestration 的 diffDocuments，前端的版本对比用的是同一个函数。
 * 两边都要是打码后的文档（secret 参数的默认值都是占位符，原值不会出现在差异里）。
 */
export function versionDiff(
	before: StoredOrchestrationDocument,
	after: StoredOrchestrationDocument,
): DocumentDiffView {
	return diffDocuments(before, after);
}
