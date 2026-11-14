import type { ParamDeclView, PresetProblemView, PresetView } from "@sfly/schema";
import { draftFromPreset, type PresetDraft } from "./preset-form";

/**
 * 失效的运行预设（GLOSSARY「失效的运行预设」）在控制台里怎么写、怎么修的纯逻辑（有单测）：
 * 失效的原因写成一句话（运行抽屉的选择框、管理对话框的列表），以及编辑表单里还没修好的地方。
 * 预设是不是失效、为什么，只看控制面算出来的 `status` 和 `problems`，这里不重新判断。
 */

/** 「不符合现在的类型（number）」；参数的声明找不到时不写类型。 */
const mismatchText = (param: string, decls: ParamDeclView[]) => {
	const type = decls.find((p) => p.name === param)?.type;
	return `不符合现在的类型${type ? `（${type}）` : ""}`;
};

/** 一个问题写成一句话：哪个参数、什么原因；类型不对时写明它现在的类型。 */
export function problemText(problem: PresetProblemView, decls: ParamDeclView[]): string {
	if (problem.reason === "missing") return `参数 ${problem.param} 已不存在`;
	return `参数 ${problem.param} 保存的值${mismatchText(problem.param, decls)}`;
}

export const problemsText = (problems: PresetProblemView[], decls: ParamDeclView[]) =>
	problems.map((p) => problemText(p, decls)).join("；");

/** 保存的值在提示里怎么写：字符串原样，其余按 JSON。 */
const savedText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** 编辑预设时还没修好的地方；新建、或者预设可用时是空的。 */
export interface Repair {
	/** 已不存在的预设参数（参数被删除或改名）：名称和保存的值，按预设里的顺序。 */
	gone: Array<{ name: string; value: unknown }>;
	/** `gone` 里还勾选着的名称：保存之前要取消勾选。 */
	kept: string[];
	/** 保存的值不符合现在的类型的预设参数 → 要求重新填写的提示；重新填写以后去掉。 */
	refill: Record<string, string>;
}

export const noRepair: Repair = { gone: [], kept: [], refill: {} };

const reasonOf = (preset: PresetView, reason: PresetProblemView["reason"]) =>
	new Set(preset.problems.filter((p) => p.reason === reason).map((p) => p.param));

export function repairOf(preset: PresetView, decls: ParamDeclView[]): Repair {
	const missing = reasonOf(preset, "missing");
	const mismatched = reasonOf(preset, "type_mismatch");
	const gone = preset.params.filter((p) => missing.has(p.name)).map((p) => ({ ...p }));
	const refill = Object.fromEntries(
		preset.params
			.filter((p) => mismatched.has(p.name))
			.map((p) => [
				p.name,
				`保存的值 ${savedText(p.value)} ${mismatchText(p.name, decls)}，请重新填写`,
			]),
	);
	return {
		gone: gone.map(({ name, value }) => ({ name, value })),
		kept: gone.map((p) => p.name),
		refill,
	};
}

/**
 * 编辑预设时表单的初始内容：和 {@link draftFromPreset} 一样，已不存在的参数不进表单；
 * 保存的值不符合现在类型的参数不带进表单，输入框留空要求重新填写（开关没有「空」，显示关）。
 */
export function repairDraft(preset: PresetView, decls: ParamDeclView[]): PresetDraft {
	const draft = draftFromPreset(preset, decls);
	const mismatched = reasonOf(preset, "type_mismatch");
	for (const p of decls) {
		if (mismatched.has(p.name) && p.type !== "boolean") draft.values[p.name] = "";
	}
	return draft;
}

/** 勾选或取消勾选一个已不存在的参数。 */
export function keepGone(repair: Repair, name: string, keep: boolean): Repair {
	const others = repair.kept.filter((n) => n !== name);
	return { ...repair, kept: keep ? [...others, name] : others };
}

/** 一个预设参数重新填写了（或取消、重新勾选了），不再要求重新填写。 */
export function refilled(repair: Repair, name: string): Repair {
	const { [name]: _, ...rest } = repair.refill;
	return { ...repair, refill: rest };
}

/** 现在还没修好的地方：没取消勾选的已不存在的参数，以及仍然勾选着、还没重新填写的参数（参数名 → 提示）。 */
export function repairErrors(
	repair: Repair,
	draft: PresetDraft,
): { gone?: string; values: Record<string, string> } {
	return {
		...(repair.kept.length > 0 && {
			gone: `${repair.kept.join("、")} 已不在入口参数里，取消勾选之后才能保存`,
		}),
		values: Object.fromEntries(
			Object.entries(repair.refill).filter(([name]) => Object.hasOwn(draft.values, name)),
		),
	};
}

export const hasRepairErrors = (errors: ReturnType<typeof repairErrors>) =>
	errors.gone !== undefined || Object.keys(errors.values).length > 0;
