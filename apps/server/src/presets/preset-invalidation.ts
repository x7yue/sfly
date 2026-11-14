import {
	type DocumentWarningView,
	type ParamDeclaration,
	PRESET_INVALIDATED_WARNING,
} from "@sfly/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/database.js";
import { orchestrationVersions, runPresets } from "../db/schema.js";
import { entryParams, type PresetProblem, presetProblems } from "./preset-validity.js";

type Declaration = z.infer<typeof ParamDeclaration>;

/** 失效的原因写成一句话：哪个参数、什么问题；类型不对时写明它现在的类型。 */
export function describePresetProblems(
	problems: readonly PresetProblem[],
	declarations: readonly Declaration[],
): string {
	return problems
		.map(({ param, reason }) => {
			if (reason === "missing") return `参数 ${param} 已不存在`;
			const type = declarations.find((d) => d.name === param)?.type;
			return `参数 ${param} 保存的值不符合现在的类型${type ? `（${type}）` : ""}`;
		})
		.join("；");
}

/**
 * 保存（或恢复）出场景的新版本以后，原来可用、对照新版本会失效的运行预设各给出一条警告
 * （docs/SEMANTICS.md §6「运行预设」）：`preset_invalidated`，消息写明预设名和原因。只警告，不阻止保存。
 * 「原来可用」是对照新版本的上一个版本；原来就已失效的预设不重复警告，第一个版本之前没有预设可言。
 * 判断用的是 {@link presetProblems}，和预设视图、触发时的检查是同一个函数。
 */
export async function presetInvalidatedWarnings(
	db: Db,
	orchestrationId: string,
	versionNumber: number,
): Promise<DocumentWarningView[]> {
	if (versionNumber <= 1) return [];
	const presets = await db
		.select()
		.from(runPresets)
		.where(eq(runPresets.orchestrationId, orchestrationId))
		.orderBy(asc(runPresets.name));
	if (presets.length === 0) return [];
	const versions = await db
		.select({ number: orchestrationVersions.number, document: orchestrationVersions.document })
		.from(orchestrationVersions)
		.where(
			and(
				eq(orchestrationVersions.orchestrationId, orchestrationId),
				inArray(orchestrationVersions.number, [versionNumber - 1, versionNumber]),
			),
		);
	const documentOf = (number: number) => versions.find((v) => v.number === number)?.document;
	const before = documentOf(versionNumber - 1);
	const after = documentOf(versionNumber);
	if (!before || !after) return [];
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
