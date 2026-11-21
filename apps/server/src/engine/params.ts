import { isDeepStrictEqual } from "node:util";
import { type ParamDeclaration, SECRET_MASK } from "@sfly/schema";

/**
 * 值是否符合参数声明的类型（docs/SEMANTICS.md §2.1）：不做类型转换，`json` 接受任何值。
 * 触发时补参数和判断运行预设是否可用（src/presets/preset-validity.ts）用的都是它。
 */
export function matchesParamType(type: ParamDeclaration["type"], value: unknown): boolean {
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
 * 用运行预设的值填入预设参数（ADR 0024「锁定由控制面执行」），之后照常补默认值、检查类型（{@link fillParams}）。
 * 传入的值里给 secret 预设参数（以 `declarations` 为准）传了任何值、或给其他预设参数传了和预设不同的值（按 JSON 深比较）时
 * 返回那个参数名；其他预设参数传相同的值照常接受。
 * secret 即使传相同的值也拒绝：否则调用方可以反复猜，从接受还是拒绝推断出原值。
 */
export function withPresetValues(
	provided: Record<string, unknown>,
	presetValues: Record<string, unknown>,
	declarations: ParamDeclaration[],
): { params: Record<string, unknown> } | { locked: string } {
	const secrets = new Set(declarations.filter((d) => d.secret).map((d) => d.name));
	for (const [name, value] of Object.entries(presetValues)) {
		if (!Object.hasOwn(provided, name)) continue;
		if (secrets.has(name) || !isDeepStrictEqual(provided[name], value)) return { locked: name };
	}
	return { params: { ...provided, ...presetValues } };
}

/**
 * 调用方给的 secret 参数里，值恰好是占位符 `******`（SECRET_MASK）的参数名。读取接口把 secret 的值打成 `******`，
 * 把读到的占位符当成值传回来（自建页面、旧版本控制台的触发表单就是这样）会让节点悄悄拿着 `******` 去跑，所以触发时拒绝，
 * 让调用方不传这个参数（用默认值）或给真正的值。普通参数没有打码，值可以是 `******`。
 */
export function placeholderParams(
	declarations: readonly ParamDeclaration[],
	provided: Record<string, unknown>,
): string[] {
	return declarations
		.filter((d) => d.secret && Object.hasOwn(provided, d.name) && provided[d.name] === SECRET_MASK)
		.map((d) => d.name);
}

/**
 * 计算链的入口参数（docs/SEMANTICS.md §2.1）：先填默认值，再用传入的值覆盖。
 * 缺少必填参数、传入未声明的参数或类型不符时返回错误。没有值的可选参数为 null。
 */
export function fillParams(
	declarations: ParamDeclaration[],
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
