import { ITEM, unionMembers, VALUE } from "./client-emit.js";
import type { RouteDef } from "./http/contract.js";

/**
 * 路由清单里字段说明的类型和写法（不依赖 Node：路由清单的构建由契约包的其他模块引用它；
 * 读源码注释要起 TypeScript 程序，在 route-docs.ts，只有生成清单的脚本用）。
 */
export type RouteDocPart = "params" | "query" | "body" | "response" | { event: string };

/**
 * 某个接口的某个部分里，一个字段（`path`：字段名，数组元素 `[]`，字典的值 `{}`，联合的成员多一段 `|…`）的说明。
 * `checkMembers` 是核对：写进 JSON Schema 时认出的联合成员（`annotateSchema` 的 `onMember`）要和读注释时认出的一致，
 * 不一致就抛错（说明会悄悄丢掉或者挂错）；测试里手写的说明函数没有它。
 */
export interface FieldDocs {
	(route: RouteDef, part: RouteDocPart, path: readonly string[]): string | undefined;
	checkMembers?(route: RouteDef, part: RouteDocPart, emitted: ReadonlySet<string>): void;
}

/**
 * 把字段说明写进导出的 JSON Schema：每个字段没有自己的 `description` 时用注释。
 * 路径的走法和 client-docs 一致：对象字段名、数组元素 `[]`、字典的值 `{}`；几选一（`anyOf`、`oneOf`）里内联的对象分支不止一个时
 * 各多一段（`|` 开头，按分支里取值固定的字段认，见 client-emit.ts 的 `unionMembers`），同名的字段在不同分支里说明可以不同；
 * 其他分支（`$ref`、字面量、数组……）和 `allOf` 的成员共用路径。
 */
export function annotateSchema(
	schema: Record<string, unknown>,
	docFor: (path: readonly string[]) => string | undefined,
	onMember?: (path: readonly string[]) => void,
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
		const branches = [json.anyOf, json.oneOf].find(Array.isArray);
		if (branches) {
			for (const { member, segment } of unionMembers(branches)) {
				if (segment === undefined) {
					visit(member, path);
					continue;
				}
				onMember?.([...path, segment]);
				visit(member, [...path, segment]);
			}
		}
		if (Array.isArray(json.allOf)) for (const branch of json.allOf) visit(branch, path);
	};
	visit(schema, []);
}
