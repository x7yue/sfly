/**
 * 扩展输入类型的标记：输入 schema 里 `x-sfly-type`（`sfly build` 写入，sdk/python/src/sfly/cli/scan.py）。
 * 这里只放判断标记的函数，没有别的依赖：`inputs.ts`、`input-types.ts` 和各类型的静态检查都用它。
 */

type JsonSchema = Record<string, unknown>;

export const INPUT_TYPE_KEY = "x-sfly-type";

const marked = (schema: unknown, type: string) =>
	schema !== null && typeof schema === "object" && (schema as JsonSchema)[INPUT_TYPE_KEY] === type;

/** 这个输入是不是某个扩展类型（`T`，或 `T | None`）。 */
export function isInputOfType(schema: JsonSchema, type: string): boolean {
	return (
		marked(schema, type) ||
		(Array.isArray(schema.anyOf) && schema.anyOf.some((s) => marked(s, type)))
	);
}
