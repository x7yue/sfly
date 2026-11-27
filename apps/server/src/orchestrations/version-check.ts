import { diffDocuments, warningIdentity as warningKey } from "@sfly/orchestration";
import {
	type CheckedWarningView,
	type DocumentDiffView,
	type DocumentWarningView,
	PRESET_INVALIDATED_WARNING,
	type StoredOrchestrationDocument,
	type VersionCheckView,
} from "@sfly/schema";
import type { Db, Tx } from "../db/database.js";
import { presetInvalidatedWarnings } from "../presets/preset-invalidation.js";
import type { ProjectId } from "../projects/project-id.js";
import { checkDocument } from "./document-checks.js";
import { secretDefaultWarnings } from "./secret-defaults.js";

/**
 * 一份即将成为（或已经成为）场景新版本的文档的警告，保存、恢复和检查（#424）共用这一处：
 * 文档的静态检查，加上会让运行预设失效的改动，以及 secret 参数写了默认值的提醒（只提醒，不阻止保存）。
 * `document` 是新版本的文档、`previous` 是它的上一个版本（第一个版本没有），都是打码后的：这几项检查都不看 secret 默认值的内容。
 * `project` 是场景所在的项目：检查里的包、Agent 都只在它的范围里找。`session` 是新版本属于的会话（`checkDocument`）。
 * `db` 由调用方传：在保存的事务里检查（`strict`）时传事务对象。
 */
export async function versionWarnings(
	db: Db | Tx,
	project: ProjectId,
	session: string | null,
	orchestrationId: string,
	document: StoredOrchestrationDocument,
	previous: StoredOrchestrationDocument | undefined,
): Promise<DocumentWarningView[]> {
	return [
		...(await checkDocument(db, project, document, session)),
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

/**
 * 给新文档的警告加上 `existing`：最新版本（`previous`）里有没有同一条。最新版本的警告对着它自己跑同样的静态检查和
 * secret 默认值的提醒（会失效的运行预设说的就是这次改动，不算已有）；同一个对象上同一种警告有几条，最新版本里有几条就有几条算已有。
 */
export async function flagExistingWarnings(
	db: Db | Tx,
	project: ProjectId,
	session: string | null,
	warnings: readonly DocumentWarningView[],
	previous: StoredOrchestrationDocument | undefined,
): Promise<CheckedWarningView[]> {
	const before = previous
		? [...(await checkDocument(db, project, previous, session)), ...secretDefaultWarnings(previous)]
		: [];
	const remaining = new Map<string, number>();
	for (const w of before) remaining.set(warningKey(w), (remaining.get(warningKey(w)) ?? 0) + 1);
	return warnings.map((w) => {
		const key = warningKey(w);
		const left = remaining.get(key) ?? 0;
		const existing = w.code !== PRESET_INVALIDATED_WARNING && left > 0;
		if (existing) remaining.set(key, left - 1);
		return { ...w, existing };
	});
}

/**
 * 检查一份即将成为新版本的文档（#424）：检查接口、保存的 `strict`、局部编辑（#470）共用。
 * 返回和保存时相同的警告（每条带 `existing`）和相对 `diffBase` 的差异。`previous` 是最新版本（还没有版本时没有），
 * `diffBase` 是差异的起点（还没有版本时是初始文档）；都是打码后的。
 */
export async function versionCheck(
	db: Db | Tx,
	project: ProjectId,
	session: string | null,
	orchestrationId: string,
	document: StoredOrchestrationDocument,
	previous: StoredOrchestrationDocument | undefined,
	diffBase: StoredOrchestrationDocument,
): Promise<VersionCheckView> {
	const warnings = await versionWarnings(db, project, session, orchestrationId, document, previous);
	return {
		warnings: await flagExistingWarnings(db, project, session, warnings, previous),
		diff: versionDiff(diffBase, document),
	};
}

/** 这次改动新带进来的警告（`strict` 和 `sfly scenario check` 的退出码只看它们）。 */
export const newWarnings = (check: VersionCheckView) => check.warnings.filter((w) => !w.existing);
