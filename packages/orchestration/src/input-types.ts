import type { NodeTypeMetadata } from "@sfly/schema";
import { orderedInputs } from "./inputs.js";

/**
 * 扩展输入类型（`sfly build` 在输入 schema 里标记）：`{"type": "string", "x-sfly-type": "<类型>"}`，
 * 可选参数（`T | None`）是 anyOf 里的一项。值都是名称字符串：「Agent」类型（`agent`，ADR 0019）、
 * 「飞书机器人」类型（`feishu_bot`，ADR 0020）。与 sdk/python/src/sfly/cli/scan.py 一致。
 */

type Io = NodeTypeMetadata["inputs"];
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

/** 节点类型里某个扩展类型的输入名（按参数顺序）。 */
export function inputsOfType(io: Io, type: string): string[] {
	return orderedInputs(io)
		.filter(([, schema]) => isInputOfType(schema, type))
		.map(([name]) => name);
}

/** 已解析的输入里，某个扩展类型的输入的值：每个值不为空的字符串一项（null、其他类型留给类型检查）。 */
export function namesInInputs(
	io: Io,
	inputs: Record<string, unknown>,
	type: string,
): { input: string; name: string }[] {
	return inputsOfType(io, type).flatMap((input) => {
		const value = inputs[input];
		return typeof value === "string" && value !== "" ? [{ input, name: value }] : [];
	});
}
