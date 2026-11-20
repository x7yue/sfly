import { ITEM, VALUE } from "./client-emit.js";
import type { RouteDef } from "./http/contract.js";

/**
 * 路由清单里字段说明的类型和写法（不依赖 Node：路由清单的构建由契约包的其他模块引用它；
 * 读源码注释要起 TypeScript 程序，在 route-docs.ts，只有生成清单的脚本用）。
 */
export type RouteDocPart = "params" | "query" | "body" | "response" | { event: string };

/** 某个接口的某个部分里，一个字段（`path`：字段名，数组元素 `[]`，字典的值 `{}`）的说明。 */
export type FieldDocs = (
	route: RouteDef,
	part: RouteDocPart,
	path: readonly string[],
) => string | undefined;

/**
 * 把字段说明写进导出的 JSON Schema：每个字段没有自己的 `description` 时用注释。
 * 路径的走法和 client-docs 一致：对象字段名、数组元素 `[]`、字典的值 `{}`，几选一的分支共用路径。
 */
export function annotateSchema(
	schema: Record<string, unknown>,
	docFor: (path: readonly string[]) => string | undefined,
): void {
	const visit = (node: unknown, path: readonly string[]): void => {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return;
		const json = node as Record<string, unknown>;
		const properties = json.properties;
		if (typeof properties === "object" && properties !== null) {
			for (const [name, sub] of Object.entries(properties)) {
				const at = [...path, name];
				if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
					const target = sub as Record<string, unknown>;
					const doc = docFor(at);
					if (doc !== undefined && target.description === undefined) target.description = doc;
				}
				visit(sub, at);
			}
		}
		visit(json.items, [...path, ITEM]);
		if (typeof json.additionalProperties === "object")
			visit(json.additionalProperties, [...path, VALUE]);
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const branches = json[key];
			if (Array.isArray(branches)) for (const branch of branches) visit(branch, path);
		}
	};
	visit(schema, []);
}
