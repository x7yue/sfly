import {
	type ParamDeclView,
	PresetDescription,
	PresetName,
	type PresetParamInput,
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
}

export const emptyDraft = (): PresetDraft => ({ name: "", description: "", values: {} });

/** 能不能设为预设参数：secret 参数暂不支持。 */
export const presetable = (p: ParamDeclView) => p.secret !== true;

/** 勾选或取消一个参数：勾选时先填上它的默认值。 */
export function toggleParam(draft: PresetDraft, p: ParamDeclView, checked: boolean): PresetDraft {
	const { [p.name]: _, ...rest } = draft.values;
	return { ...draft, values: checked ? { ...rest, [p.name]: fieldValue(p, p.default) } : rest };
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

/** 校验草稿：勾选的参数必须填值（字符串不能为空），数字与 JSON 要格式正确。 */
export function draftErrors(draft: PresetDraft, decls: ParamDeclView[]): DraftErrors {
	const errors: DraftErrors = { values: {} };
	const name = PresetName.safeParse(draft.name);
	if (!name.success) errors.name = name.error.issues[0]?.message;
	const description = PresetDescription.safeParse(draft.description);
	if (!description.success) errors.description = description.error.issues[0]?.message;
	const checked = decls.filter((p) => Object.hasOwn(draft.values, p.name));
	if (checked.length === 0) errors.params = "至少勾选一个参数";
	for (const p of checked) {
		const result = fieldSchema(p, true).safeParse(draft.values[p.name]);
		const message = result.error?.issues[0]?.message;
		if (message) errors.values[p.name] = message;
	}
	return errors;
}

/** 已通过校验的草稿 → 新建预设的请求体；预设参数按声明顺序。 */
export function toPresetBody(
	draft: PresetDraft,
	decls: ParamDeclView[],
): { name: string; description: string; params: PresetParamInput[] } {
	return {
		name: draft.name.trim(),
		description: draft.description.trim(),
		params: decls
			.filter((p) => Object.hasOwn(draft.values, p.name))
			.map((p) => ({ name: p.name, value: toParamValue(p, draft.values[p.name]) })),
	};
}
