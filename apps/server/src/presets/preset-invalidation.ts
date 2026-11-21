import {
	type DocumentWarningView,
	PRESET_INVALIDATED_WARNING,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { runPresets } from "../db/schema.js";
import { describePresetProblems, entryParams, presetProblems } from "./preset-validity.js";

/**
 * 保存（或恢复）出场景的新版本以后，原来可用、对照新版本会失效的运行预设各给出一条警告
 * （docs/SEMANTICS.md §6「运行预设」）：`preset_invalidated`，消息写明预设名和原因。只警告，不阻止保存。
 * 「原来可用」是对照新版本的上一个版本（`before`）；原来就已失效的预设不重复警告，第一个版本之前（没有 `before`）没有预设可言。
 * 检查（不保存）时 `after` 是保存之后会存成的文档、`before` 是最新版本。
 * 判断用的是 {@link presetProblems}，和预设视图、触发时的检查是同一个函数。
 */
export async function presetInvalidatedWarnings(
	db: Db,
	orchestrationId: string,
	before: StoredOrchestrationDocument | undefined,
	after: StoredOrchestrationDocument,
): Promise<DocumentWarningView[]> {
	if (!before) return [];
	const presets = await db
		.select()
		.from(runPresets)
		.where(eq(runPresets.orchestrationId, orchestrationId))
		.orderBy(asc(runPresets.name));
	if (presets.length === 0) return [];
	const [wasDeclared, nowDeclared] = [entryParams(before), entryParams(after)];
	return presets.flatMap((preset) => {
		if (presetProblems(preset.values, wasDeclared).length > 0) return [];
		const problems = presetProblems(preset.values, nowDeclared);
		if (problems.length === 0) return [];
		return [
			{
				code: PRESET_INVALIDATED_WARNING,
				message: `运行预设「${preset.name}」已失效：${describePresetProblems(problems, nowDeclared)}`,
			},
		];
	});
}
