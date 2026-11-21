import type { NodeTypeMetadata, StoredOrchestrationDocument } from "@sfly/schema";
import { isInputOfType } from "./input-marker.js";
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
 * allowNull：always 节点引用缺失的输出解析为 null（docs/SEMANTICS.md §2.4），null 不算类型不符。
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

/** 编辑距离，相邻两个字符颠倒算一次改动（拼写错误里最常见的一种）。 */
function editDistance(a: string, b: string): number {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => [
		i,
		...new Array<number>(b.length).fill(0),
	]);
	const row0 = rows[0] as number[];
	for (let j = 0; j <= b.length; j++) row0[j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const row = rows[i] as number[];
			row[j] = Math.min(
				((rows[i - 1] as number[])[j] as number) + 1,
				(row[j - 1] as number) + 1,
				((rows[i - 1] as number[])[j - 1] as number) + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				row[j] = Math.min(row[j] as number, ((rows[i - 2] as number[])[j - 2] as number) + 1);
			}
		}
	}
	return (rows[a.length] as number[])[b.length] as number;
}

/**
 * 写错的输入名最像哪个已声明的输入：只差一两个字符（不区分大小写，相邻字符颠倒算一个），
 * 名字够长（8 个字符以上）时可以差两个；太短的名字、差得远的不猜。没有时为 undefined。
 */
export function similarInput(name: string, declared: readonly string[]): string | undefined {
	const lower = name.toLowerCase();
	let best: { name: string; distance: number } | undefined;
	for (const candidate of declared) {
		const other = candidate.toLowerCase();
		const distance = editDistance(lower, other);
		const allowed = Math.max(lower.length, other.length) >= 8 ? 2 : 1;
		if (distance > allowed || distance >= Math.min(lower.length, other.length)) continue;
		if (best === undefined || distance < best.distance) best = { name: candidate, distance };
	}
	return best?.name;
}

/**
 * 节点类型是不是接收没有声明的输入：输入 schema 的 `additionalProperties` 是 true 或一个 schema（JSON Schema 的写法）。
 * `sfly build` 不接受 `**kwargs`，所以 SDK 生成的元信息里没有这种写法，不会误报；这是给手写的元信息留的口子。
 */
const acceptsAnyInput = (io: Io): boolean =>
	io.additionalProperties === true ||
	(typeof io.additionalProperties === "object" && io.additionalProperties !== null);

/** 节点上写了、但节点类型没有声明的输入名（按写入的顺序）；节点类型接收任意输入时没有。画布和静态检查共用。 */
export function undeclaredInputs(io: Io, inputs: Record<string, unknown>): string[] {
	if (acceptsAnyInput(io)) return [];
	return Object.keys(inputs).filter((name) => !Object.hasOwn(io.properties, name));
}

/** 没有声明的输入的说明：写明是哪个输入、节点类型声明了哪些输入，能猜到时问是不是想写另一个。 */
function undeclaredInputMessage(
	node: { node: string; inputs: Record<string, unknown> },
	label: string,
	io: Io,
	input: string,
): string {
	const declared = orderedInputs(io).map(([name]) => name);
	const head = `节点 ${label} 的输入 ${input} 没有声明：节点类型 ${node.node}`;
	if (declared.length === 0) return `${head} 不接收任何输入；删掉这个输入`;
	const listed = `${head} 声明的输入有 ${declared.join("、")}`;
	// 已经写了的输入不再建议（它们是对的）。
	const similar = similarInput(
		input,
		declared.filter((name) => !Object.hasOwn(node.inputs, name)),
	);
	return similar === undefined
		? `${listed}；改成其中一个，或者删掉这个输入`
		: `${listed}；是不是想写 ${similar}？`;
}

export interface InputWarning {
	code: "input_required" | "input_type_mismatch" | "input_not_declared";
	message: string;
	node_id: string;
	input: string;
}

/**
 * 输入的静态检查（保存时警告，触发时必须通过）：包节点的必填输入要填写；写的输入名要是节点类型声明过的
 * （没有声明的，执行器在运行时以 config_error 拒绝，`runner.py` 的 `_check_declared`）；常量要符合输入类型。
 * 含引用的值在派发时才知道类型，这里不检查类型，输入名照样检查；节点类型未知时跳过（包版本检查会指出）。
 * 三种问题级别相同：保存只警告（草稿可以先存着），触发前必须改好，运行时都是同一个 config_error。
 */
export function inputWarnings(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
): InputWarning[] {
	const warnings: InputWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const type = nodeTypeOf(doc, node, catalog);
		if (!type) continue;
		// 「运行状态」类型的输入由 run-state-references.ts 检查，说明里直接写出该填什么。
		const owned = (name: string) => {
			const schema = type.inputs.properties[name];
			return schema !== undefined && isInputOfType(schema, "run_state");
		};
		for (const input of missingInputs(type.inputs, node.inputs).filter((name) => !owned(name))) {
			warnings.push({
				code: "input_required",
				message: `节点 ${nodeNameWithId(node)} 的必填输入 ${input} 没有填写`,
				node_id: node.id,
				input,
			});
		}
		const undeclared = new Set(undeclaredInputs(type.inputs, node.inputs));
		for (const [input, value] of Object.entries(node.inputs)) {
			if (undeclared.has(input)) {
				warnings.push({
					code: "input_not_declared",
					message: undeclaredInputMessage(node, nodeNameWithId(node), type.inputs, input),
					node_id: node.id,
					input,
				});
				continue;
			}
			if (referencesIn(value).length > 0 || owned(input)) continue;
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
