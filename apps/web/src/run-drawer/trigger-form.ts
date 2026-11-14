import type { ParamDeclView } from "@sfly/schema";
import { z } from "zod";

/**
 * 运行抽屉的入口参数表单（纯逻辑，有单测）：按入口节点声明的参数生成初始值、zod 校验与触发参数。
 * 表单里的值：布尔参数是开关（boolean），其余都是输入框里的文本。单个参数的换算与校验
 * （{@link fieldValue}、{@link fieldSchema}、{@link toParamValue}）也给运行预设的编辑表单用。
 */

export type FieldValue = string | boolean;
export type FormValues = Record<string, FieldValue>;

/** 必填且没有默认值：留空时不能触发。 */
const mustFill = (p: ParamDeclView) => p.required === true && p.default === undefined;

/** 参数值 → 表单里的值；没有值时布尔参数是关，其余为空。 */
export function fieldValue(p: ParamDeclView, value: unknown): FieldValue {
	if (p.type === "boolean") return value === true;
	if (value === undefined || value === null) return "";
	return p.type === "json" ? JSON.stringify(value) : String(value);
}

/**
 * 运行预设锁定的参数在表单里的值：secret 参数是接口返回的打码值，原样显示（不按类型换算）；其余按类型换算。
 */
export function lockedValue(p: ParamDeclView, value: unknown): FieldValue {
	return p.secret ? String(value) : fieldValue(p, value);
}

function initialValue(p: ParamDeclView, initial?: Record<string, unknown>): FieldValue {
	return fieldValue(
		p,
		initial && !p.secret && Object.hasOwn(initial, p.name) ? initial[p.name] : p.default,
	);
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

/** 一个参数的校验规则；`required` 时留空报「必填」（默认是必填且没有默认值的参数）。 */
export function fieldSchema(
	p: ParamDeclView,
	required = mustFill(p),
): z.ZodType<FieldValue, FieldValue> {
	if (p.type === "boolean") return z.boolean();
	return z.string().superRefine((raw, ctx) => {
		const text = raw.trim();
		if (text === "") {
			if (required) ctx.addIssue({ code: "custom", message: "必填" });
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

/** 已通过校验的一个表单值 → 参数值：数字与 JSON 按类型解析；留空时为 undefined。 */
export function toParamValue(p: ParamDeclView, value: FieldValue | undefined): unknown {
	if (typeof value === "boolean") return value;
	const text = (value ?? "").trim();
	if (text === "") return undefined;
	if (p.type === "number") return Number(text);
	if (p.type === "json") return JSON.parse(text);
	return value;
}

/** 已通过校验的表单值 → 触发参数；留空的参数不传（控制面按默认值填充）。 */
export function toParams(decls: ParamDeclView[], values: FormValues): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	for (const p of decls) {
		const value = toParamValue(p, values[p.name]);
		if (value !== undefined) params[p.name] = value;
	}
	return params;
}
