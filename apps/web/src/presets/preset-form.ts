import {
	type ParamDeclView,
	PresetDescription,
	PresetName,
	type PresetParamInput,
	type PresetView,
} from "@sfly/schema";
import { type FieldValue, fieldSchema, fieldValue, toParamValue } from "#/run-drawer/trigger-form";

/**
 * 运行预设编辑表单的纯逻辑（有单测）：勾选哪些参数作为预设参数、它们的值、校验与请求体。
 * 参数值的换算与校验沿用运行抽屉的入口参数表单（run-drawer/trigger-form.ts）。
 */

export interface PresetDraft {
	name: string;
	description: string;
	/** 勾选为预设参数的参数 → 表单里的值；没勾选的参数不在里面。 */
	values: Record<string, FieldValue>;
	/**
	 * 勾选了、沿用预设里原来的 secret 值的参数（接口不返回 secret 的原值，不点「替换」就提交 `keep`）；
	 * 它们在 `values` 里的值是空的。
	 */
	kept: string[];
}

export const emptyDraft = (): PresetDraft => ({ name: "", description: "", values: {}, kept: [] });

/**
 * 编辑已有的预设：表单带着它现在的名称、说明和预设参数（值换成表单里的写法），没固定的参数不勾选。
 * secret 参数的原值看不到，沿用它（`kept`），点「替换」才重新输入（{@link replaceSecret}）。
 */
export function draftFromPreset(preset: PresetView, decls: ParamDeclView[]): PresetDraft {
	const values: Record<string, FieldValue> = {};
	const kept: string[] = [];
	for (const p of decls) {
		const fixed = preset.params.find((q) => q.name === p.name);
		if (!fixed) continue;
		if (p.secret) {
			values[p.name] = "";
			kept.push(p.name);
		} else values[p.name] = fieldValue(p, fixed.value);
	}
	return { name: preset.name, description: preset.description, values, kept };
}

/** 点「替换」：不再沿用这个 secret 参数的原值，表单里重新输入。 */
export function replaceSecret(draft: PresetDraft, name: string): PresetDraft {
	return {
		...draft,
		kept: draft.kept.filter((k) => k !== name),
		values: { ...draft.values, [name]: "" },
	};
}

/** 预设里已经不在入口参数里的预设参数（参数被删除或改名）：编辑表单里没有它们的位置，保存时会丢掉。 */
export function removedParams(preset: PresetView, decls: ParamDeclView[]): string[] {
	return preset.params.filter((q) => !decls.some((p) => p.name === q.name)).map((q) => q.name);
}

/** 勾选或取消一个参数：勾选时先填上它的默认值；取消再勾选的 secret 参数原值已经不在了，要重新输入。 */
export function toggleParam(draft: PresetDraft, p: ParamDeclView, checked: boolean): PresetDraft {
	const { [p.name]: _, ...rest } = draft.values;
	return {
		...draft,
		values: checked ? { ...rest, [p.name]: fieldValue(p, p.default) } : rest,
		kept: draft.kept.filter((k) => k !== p.name),
	};
}

/** 校验错误：名称、说明、一个参数都没勾选，以及勾选的参数各自的错误（参数名 → 错误信息）。 */
export interface DraftErrors {
	name?: string;
	description?: string;
	params?: string;
	values: Record<string, string>;
}

export const hasErrors = (errors: DraftErrors) =>
	errors.name !== undefined ||
	errors.description !== undefined ||
	errors.params !== undefined ||
	Object.keys(errors.values).length > 0;

/** 校验表单内容：勾选的参数必须填值（字符串不能为空），数字与 JSON 要格式正确；沿用原值的 secret 参数不用填。 */
export function draftErrors(draft: PresetDraft, decls: ParamDeclView[]): DraftErrors {
	const errors: DraftErrors = { values: {} };
	const name = PresetName.safeParse(draft.name);
	if (!name.success) errors.name = name.error.issues[0]?.message;
	const description = PresetDescription.safeParse(draft.description);
	if (!description.success) errors.description = description.error.issues[0]?.message;
	const checked = decls.filter((p) => Object.hasOwn(draft.values, p.name));
	if (checked.length === 0) errors.params = "至少勾选一个参数";
	for (const p of checked.filter((c) => !draft.kept.includes(c.name))) {
		const result = fieldSchema(p, true).safeParse(draft.values[p.name]);
		const message = result.error?.issues[0]?.message;
		if (message) errors.values[p.name] = message;
	}
	return errors;
}

/** 已通过校验的表单内容 → 新建或修改预设的请求体（预设参数的完整清单）；预设参数按声明顺序。 */
export function toPresetBody(
	draft: PresetDraft,
	decls: ParamDeclView[],
): { name: string; description: string; params: PresetParamInput[] } {
	return {
		name: draft.name.trim(),
		description: draft.description.trim(),
		params: decls
			.filter((p) => Object.hasOwn(draft.values, p.name))
			.map((p) =>
				draft.kept.includes(p.name)
					? { name: p.name, keep: true as const }
					: { name: p.name, value: toParamValue(p, draft.values[p.name]) },
			),
	};
}
