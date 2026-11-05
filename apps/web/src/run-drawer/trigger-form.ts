import type { ParamDeclView } from "@sfly/schema";
import { z } from "zod";

/**
 * 运行抽屉的入口参数表单（纯逻辑，有单测）：按入口节点声明的参数生成初始值、zod 校验与触发参数。
 * 表单里的值：布尔参数是开关（boolean），其余都是输入框里的文本。
 */

export type FieldValue = string | boolean;
export type FormValues = Record<string, FieldValue>;

/** 必填且没有默认值：留空时不能触发。 */
const mustFill = (p: ParamDeclView) => p.required === true && p.default === undefined;

function initialValue(p: ParamDeclView, initial?: Record<string, unknown>): FieldValue {
	const value =
		initial && !p.secret && Object.hasOwn(initial, p.name) ? initial[p.name] : p.default;
	if (p.type === "boolean") return value === true;
	if (value === undefined || value === null) return "";
	return p.type === "json" ? JSON.stringify(value) : String(value);
}

/** 初始值：给了 initial（再次运行时为上次运行的参数）时沿用它，敏感参数除外；否则用声明的默认值。 */
export function initialValues(
	decls: ParamDeclView[],
	initial?: Record<string, unknown>,
): FormValues {
	return Object.fromEntries(decls.map((p) => [p.name, initialValue(p, initial)]));
}

const isJson = (text: string) => {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};

function fieldSchema(p: ParamDeclView): z.ZodType<FieldValue, FieldValue> {
	if (p.type === "boolean") return z.boolean();
	return z.string().superRefine((raw, ctx) => {
		const text = raw.trim();
		if (text === "") {
			if (mustFill(p)) ctx.addIssue({ code: "custom", message: "必填" });
			return;
		}
		if (p.type === "number" && !Number.isFinite(Number(text))) {
			ctx.addIssue({ code: "custom", message: "需要一个数字" });
		} else if (p.type === "json" && !isJson(text)) {
			ctx.addIssue({ code: "custom", message: "不是合法的 JSON" });
		}
	});
}

/** 表单值的校验规则：错误信息挂在对应参数名上（TanStack Form 按 path 分发到字段）。 */
export function paramsSchema(decls: ParamDeclView[]): z.ZodType<FormValues, FormValues> {
	return z.object(Object.fromEntries(decls.map((p) => [p.name, fieldSchema(p)])));
}

/** 已通过校验的表单值 → 触发参数；留空的参数不传（控制面按默认值填充）。 */
export function toParams(decls: ParamDeclView[], values: FormValues): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	for (const p of decls) {
		const value = values[p.name];
		if (typeof value === "boolean") {
			params[p.name] = value;
			continue;
		}
		const text = (value ?? "").trim();
		if (text === "") continue;
		if (p.type === "number") params[p.name] = Number(text);
		else if (p.type === "json") params[p.name] = JSON.parse(text);
		else params[p.name] = value;
	}
	return params;
}
