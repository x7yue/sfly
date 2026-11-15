import type { NodeTypeMetadata, OrchestrationDocument } from "@sfly/schema";
import { nodeNameWithId } from "./node-display.js";
import { nodeTypeOf, type PackageCatalog, referencesIn } from "./references.js";

/**
 * 包节点输入的校验（docs/SEMANTICS.md §3.3 config_error「参数校验失败」）：按节点类型的输入 schema
 * （`sfly build` 由函数签名生成的 JSON Schema 子集：type、enum、anyOf、items、properties、required、
 * additionalProperties）检查必填和类型。派发前由控制面检查已解析的输入；静态检查只检查常量。
 */

type Io = NodeTypeMetadata["inputs"];
type JsonSchema = Record<string, unknown>;

/** 输入 schema 的字段，按 `order`（函数参数顺序）排列；order 里没有的键按原顺序排在后面。 */
export function orderedInputs(io: Io): [string, JsonSchema][] {
	const entries = Object.entries(io.properties);
	const rank = new Map((io.order ?? []).map((name, i) => [name, i]));
	return entries
		.map((entry, i) => ({ entry, key: rank.get(entry[0]) ?? rank.size + i }))
		.sort((a, b) => a.key - b.key)
		.map((e) => e.entry);
}

/**
 * 输入或输出的说明：节点包用 `Annotated[类型, Doc("…")]` 写的，元信息里是这一项 schema 的 `description`。
 * 没写、写的不是字符串时为 undefined（旧版本的节点包都没有）。
 */
export function schemaDescription(schema: JsonSchema | undefined): string | undefined {
	const text = schema?.description;
	return typeof text === "string" && text !== "" ? text : undefined;
}

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/** schema 的简短描述（错误信息用）。 */
export function describeSchema(schema: JsonSchema): string {
	if (Array.isArray(schema.enum)) return `${schema.enum.map(show).join(" | ")} 之一`;
	if (Array.isArray(schema.anyOf))
		return (schema.anyOf as JsonSchema[]).map(describeSchema).join(" | ");
	if (typeof schema.type === "string") return schema.type;
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	return "任意值";
}

function matchesType(type: unknown, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		default:
			return true;
	}
}

/** 值是否符合 schema（只支持上面列出的关键字，其余关键字忽略）。 */
export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => show(e) === show(value))) return false;
	if (
		Array.isArray(schema.anyOf) &&
		!(schema.anyOf as JsonSchema[]).some((s) => matchesSchema(s, value))
	)
		return false;
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType(t, value))) return false;
	}
	if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
		if (!value.every((item) => matchesSchema(schema.items as JsonSchema, item))) return false;
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
		for (const name of (schema.required ?? []) as string[]) {
			if (!Object.hasOwn(record, name)) return false;
		}
		for (const [key, item] of Object.entries(record)) {
			const sub = Object.hasOwn(properties, key)
				? properties[key]
				: typeof schema.additionalProperties === "object"
					? (schema.additionalProperties as JsonSchema)
					: undefined;
			if (sub && !matchesSchema(sub, item)) return false;
		}
	}
	return true;
}

/** 必填但没有给出的输入。 */
export function missingInputs(io: Io, inputs: Record<string, unknown>): string[] {
	return (io.required ?? []).filter((name) => !Object.hasOwn(inputs, name));
}

/** 类型不符时的说明；相符时为 undefined。 */
export function typeProblem(io: Io, name: string, value: unknown): string | undefined {
	const schema = io.properties[name];
	if (!schema || matchesSchema(schema, value)) return undefined;
	return `输入 ${name} 应为 ${describeSchema(schema)}，实际是 ${show(value)}`;
}

/**
 * 已解析的输入是否符合节点类型的输入 schema；返回问题列表（空表示通过）。
 * allowNull：always 节点引用缺失的输出解析为 null（§2.4），null 不算类型不符。
 * 没有在 schema 里声明的输入不在这里检查。
 */
export function inputProblems(
	io: Io,
	inputs: Record<string, unknown>,
	options: { allowNull?: boolean } = {},
): string[] {
	const problems = missingInputs(io, inputs).map((name) => `缺少必填输入 ${name}`);
	for (const [name, value] of Object.entries(inputs)) {
		if (value === null && options.allowNull) continue;
		const problem = typeProblem(io, name, value);
		if (problem) problems.push(problem);
	}
	return problems;
}

export interface InputWarning {
	code: "input_required" | "input_type_mismatch";
	message: string;
	node_id: string;
	input: string;
}

/**
 * 输入的静态检查（保存时警告，触发时必须通过）：包节点的必填输入要填写；常量要符合输入类型。
 * 含引用的值在派发时才知道类型，这里不检查；节点类型未知时跳过（包版本检查会指出）。
 */
export function inputWarnings(doc: OrchestrationDocument, catalog: PackageCatalog): InputWarning[] {
	const warnings: InputWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const type = nodeTypeOf(doc, node, catalog);
		if (!type) continue;
		for (const input of missingInputs(type.inputs, node.inputs)) {
			warnings.push({
				code: "input_required",
				message: `节点 ${nodeNameWithId(node)} 的必填输入 ${input} 没有填写`,
				node_id: node.id,
				input,
			});
		}
		for (const [input, value] of Object.entries(node.inputs)) {
			if (referencesIn(value).length > 0) continue;
			const problem = typeProblem(type.inputs, input, value);
			if (!problem) continue;
			warnings.push({
				code: "input_type_mismatch",
				message: `节点 ${nodeNameWithId(node)} 的${problem}`,
				node_id: node.id,
				input,
			});
		}
	}
	return warnings;
}
