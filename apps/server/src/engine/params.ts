import type { ParamDeclaration } from "@sfly/schema";
import type { z } from "zod";

type Declaration = z.infer<typeof ParamDeclaration>;

/**
 * 值是否符合参数声明的类型（docs/SEMANTICS.md §2.1）：不做类型转换，`json` 接受任何值。
 * 触发时补参数和判断运行预设是否可用（src/presets/preset-validity.ts）用的都是它。
 */
export function matchesParamType(type: Declaration["type"], value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "json":
			return true;
	}
}

/**
 * 计算链的入口参数（docs/SEMANTICS.md §2.1）：先填默认值，再用传入的值覆盖。
 * 缺少必填参数、传入未声明的参数或类型不符时返回错误。没有值的可选参数为 null。
 */
export function fillParams(
	declarations: Declaration[],
	provided: Record<string, unknown>,
): { params: Record<string, unknown> } | { errors: string[] } {
	const errors: string[] = [];
	const declared = new Map(declarations.map((d) => [d.name, d]));
	for (const name of Object.keys(provided)) {
		if (!declared.has(name)) errors.push(`unknown param: ${name}`);
	}
	const missing: string[] = [];
	const params: Record<string, unknown> = {};
	for (const decl of declarations) {
		const value = Object.hasOwn(provided, decl.name) ? provided[decl.name] : decl.default;
		if (value === undefined || value === null) {
			if (decl.required) missing.push(decl.name);
			params[decl.name] = null;
			continue;
		}
		if (!matchesParamType(decl.type, value)) {
			errors.push(`param ${decl.name} must be of type ${decl.type}`);
		}
		params[decl.name] = value;
	}
	if (missing.length > 0) errors.unshift(`missing required params: ${missing.join(", ")}`);
	return errors.length > 0 ? { errors } : { params };
}
