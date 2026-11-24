export type Json = Record<string, unknown>;

const VALUE_ONLY = new Set([
	"$schema",
	"id",
	"title",
	"description",
	"default",
	"examples",
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"contentEncoding",
	"contentMediaType",
	"readOnly",
	"writeOnly",
]);

const STRUCTURAL = new Set([
	"$ref",
	"type",
	"enum",
	"const",
	"anyOf",
	"oneOf",
	"allOf",
	"properties",
	"required",
	"additionalProperties",
	"propertyNames",
	"items",
	"prefixItems",
	"not",
]);

export const ITEM = "[]";
export const VALUE = "{}";
/**
 * 说明路径里「几选一的哪个成员」这一段的开头（`|`）：联合里内联的对象成员各有自己的字段说明，同名的字段在不同成员里
 * 说明可以不同，所以路径要认成员。成员用它里面取值固定的字段（字面量，如 `type: "notice"`）来认，见 {@link memberSegment}。
 * 生成类型、导出的 JSON Schema、读契约注释三处用同一套写法，路径才对得上。
 */
export const MEMBER = "|";

/** 联合里的一个对象成员在路径里的一段：取值固定的字段（`名=值`）合起来认它，排序之后连起来；没有取值固定的字段就是 `|`。 */
export function memberSegment(fixed: readonly string[]): string {
	return `${MEMBER}${[...fixed].sort().join(",")}`;
}

/** JSON Schema 里一个字段取值固定（`const`，或只有一项的 `enum`）时的值（JSON 写法），否则 undefined。 */
function fixedValue(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const json = schema as Json;
	const value =
		"const" in json
			? json.const
			: Array.isArray(json.enum) && json.enum.length === 1
				? json.enum[0]
				: undefined;
	return ["string", "number", "boolean"].includes(typeof value) ? JSON.stringify(value) : undefined;
}

/** 一个对象的 JSON Schema 在联合里的路径段（按它的 `properties` 里取值固定的字段）。 */
function objectMember(json: Json): string {
	const fixed: string[] = [];
	for (const [name, sub] of Object.entries((json.properties ?? {}) as Record<string, unknown>)) {
		const value = fixedValue(sub);
		if (value !== undefined) fixed.push(`${name}=${value}`);
	}
	return memberSegment(fixed);
}

const isInlineObject = (member: unknown): member is Json =>
	typeof member === "object" && member !== null && (member as Json).type === "object";

/** 一个 JSON Schema 里的联合（`anyOf`，没有就 `oneOf`）的成员；不是联合返回 undefined。 */
function combinerOf(json: Json): readonly unknown[] | undefined {
	for (const combiner of ["anyOf", "oneOf"] as const) {
		const members = json[combiner];
		if (Array.isArray(members)) return members;
	}
	return undefined;
}

/**
 * 联合的成员（成员自己又是联合的展开，和 TypeScript 的联合一样是平的），以及每个成员在说明路径里的一段 `segment`：
 * 内联的对象成员（不是 `$ref`，`$ref` 指向的类型自己有一份说明）在这个联合里**不止一个**时，每个各带一段，
 * 同名的字段在不同成员里说明可以不同；只有一个（可空、可选的对象）时和没有联合一样，路径不变。
 */
export function unionMembers(
	members: readonly unknown[],
): Array<{ member: unknown; segment?: string }> {
	const flat: unknown[] = [];
	const spread = (list: readonly unknown[]) => {
		for (const member of list) {
			const nested =
				typeof member === "object" && member !== null ? combinerOf(member as Json) : undefined;
			if (nested) spread(nested);
			else flat.push(member);
		}
	};
	spread(members);
	const several = flat.filter(isInlineObject).length >= 2;
	return flat.map((member) => ({
		member,
		segment: several && isInlineObject(member) ? objectMember(member) : undefined,
	}));
}

export class UnsupportedSchema extends Error {
	constructor(where: string, reason: string) {
		super(`${where}: ${reason}`);
		this.name = "UnsupportedSchema";
	}
}

export interface EmitOptions {
	refName: (id: string) => string;
	doc?: (path: readonly string[]) => string | undefined;
	/** 走进联合的一个内联的对象成员时调用（路径含这个成员的一段）：生成之后和读到的注释核对，两边认出的成员要一样。 */
	member?: (path: readonly string[]) => void;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propertyKey = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));

function literal(value: unknown, where: string): string {
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
		return JSON.stringify(value);
	}
	throw new UnsupportedSchema(where, `literal ${JSON.stringify(value)} is not a primitive`);
}

function topLevel(text: string): string {
	let depth = 0;
	let out = "";
	for (const ch of text) {
		if ("{[(<".includes(ch)) depth++;
		else if ("}])>".includes(ch)) depth--;
		else if (depth === 0) out += ch;
	}
	return out;
}

const parenthesize = (text: string, operators: RegExp) =>
	operators.test(topLevel(text)) ? `(${text})` : text;

function union(parts: string[]): string {
	const unique = [...new Set(parts)];
	return unique.includes("unknown") ? "unknown" : unique.join(" | ");
}

export function typeText(
	schema: unknown,
	options: EmitOptions,
	indent = "",
	path: readonly string[] = [],
): string {
	const where = path.join(".") || "<root>";
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (typeof schema !== "object" || schema === null) {
		throw new UnsupportedSchema(where, `schema ${JSON.stringify(schema)} is not an object`);
	}
	const json = schema as Json;
	for (const keyword of Object.keys(json)) {
		if (!VALUE_ONLY.has(keyword) && !STRUCTURAL.has(keyword)) {
			throw new UnsupportedSchema(where, `unsupported JSON Schema keyword "${keyword}"`);
		}
	}
	const recur = (child: unknown, childPath = path) => typeText(child, options, indent, childPath);

	if (typeof json.$ref === "string") {
		const siblings = Object.keys(json).filter((k) => STRUCTURAL.has(k) && k !== "$ref");
		if (siblings.length > 0) throw new UnsupportedSchema(where, `$ref next to ${siblings}`);
		const match = /^#\/\$defs\/(.+)$/.exec(json.$ref);
		if (!match) throw new UnsupportedSchema(where, `$ref ${json.$ref} does not point into $defs`);
		return options.refName(decodeURIComponent(match[1] as string));
	}
	if ("const" in json) return literal(json.const, where);
	if (Array.isArray(json.enum)) return union(json.enum.map((v) => literal(v, where)));
	const members = combinerOf(json);
	if (members) {
		return union(
			unionMembers(members).map(({ member, segment }) => {
				if (segment === undefined) return recur(member);
				options.member?.([...path, segment]);
				return recur(member, [...path, segment]);
			}),
		);
	}
	if (Array.isArray(json.allOf)) {
		return json.allOf.map((member) => parenthesize(recur(member), /[|]|=>/)).join(" & ");
	}
	if ("not" in json) {
		if (typeof json.not === "object" && json.not && Object.keys(json.not).length === 0) {
			return "never";
		}
		throw new UnsupportedSchema(where, '"not" with a non-empty schema');
	}

	const type = json.type;
	if (Array.isArray(type)) return union(type.map((t) => recur({ ...json, type: t })));
	switch (type) {
		case undefined: {
			const structural = Object.keys(json).filter((k) => STRUCTURAL.has(k));
			if (structural.length > 0) throw new UnsupportedSchema(where, `untyped ${structural}`);
			return "unknown";
		}
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return arrayText(json, options, indent, path);
		case "object":
			return objectText(json, options, indent, path);
		default:
			throw new UnsupportedSchema(where, `unsupported type ${JSON.stringify(type)}`);
	}
}

function arrayText(json: Json, options: EmitOptions, indent: string, path: readonly string[]) {
	const item = (child: unknown) => typeText(child, options, indent, [...path, ITEM]);
	if (Array.isArray(json.prefixItems)) {
		const head = json.prefixItems.map(item);
		const rest =
			json.items === undefined || json.items === false
				? []
				: [`...${parenthesize(item(json.items), /[|&]|=>/)}[]`];
		return `[${[...head, ...rest].join(", ")}]`;
	}
	if (json.items === undefined) return "unknown[]";
	return `${parenthesize(item(json.items), /[|&]|=>/)}[]`;
}

function objectText(json: Json, options: EmitOptions, indent: string, path: readonly string[]) {
	const where = path.join(".") || "<root>";
	const properties = (json.properties ?? {}) as Record<string, unknown>;
	const names = Object.keys(properties);
	const extra = json.additionalProperties;
	const keys = json.propertyNames as Json | undefined;
	const inner = `${indent}\t`;
	const valueText = (child: unknown, childIndent: string) =>
		typeText(child, options, childIndent, [...path, VALUE]);

	if (keys !== undefined) {
		if (names.length > 0) throw new UnsupportedSchema(where, "propertyNames next to properties");
		if (Array.isArray(keys.enum)) {
			const required = new Set((json.required ?? []) as string[]);
			const value = valueText(extra ?? true, inner);
			const lines = (keys.enum as string[]).map(
				(k) => `${inner}${propertyKey(k)}${required.has(k) ? "" : "?"}: ${value};`,
			);
			return `{\n${lines.join("\n")}\n${indent}}`;
		}
		const key = typeText(keys, options, indent, path);
		return `Record<${key}, ${extra === undefined || extra === true ? "unknown" : valueText(extra, indent)}>`;
	}

	if (names.length === 0) {
		if (extra === false || (extra === undefined && "properties" in json)) {
			return "Record<string, never>";
		}
		return `Record<string, ${extra === undefined || extra === true ? "unknown" : valueText(extra, indent)}>`;
	}

	const required = new Set((json.required ?? []) as string[]);
	const lines: string[] = [];
	for (const name of names) {
		const childPath = [...path, name];
		const doc = options.doc?.(childPath);
		if (doc) lines.push(...docLines(doc, inner));
		const child = typeText(properties[name], options, inner, childPath);
		lines.push(`${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${child};`);
	}
	if (extra !== undefined && extra !== false) {
		if (extra !== true && valueText(extra, inner) !== "unknown") {
			throw new UnsupportedSchema(where, "typed additionalProperties next to named properties");
		}
		lines.push(`${inner}[key: string]: unknown;`);
	}
	return `{\n${lines.join("\n")}\n${indent}}`;
}

export function docLines(doc: string, indent: string): string[] {
	const lines = doc.split("\n").map((line) => line.replaceAll("*/", "*\\/"));
	if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
	return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

export function declaration(name: string, schema: Json, options: EmitOptions, doc?: string) {
	const head = doc ? `${docLines(doc, "").join("\n")}\n` : "";
	const text = typeText(schema, options);
	const plainObject =
		schema.type === "object" &&
		!schema.propertyNames &&
		Object.keys((schema.properties ?? {}) as object).length > 0 &&
		!["$ref", "const", "enum", "anyOf", "oneOf", "allOf"].some((k) => k in schema);
	return plainObject
		? `${head}export interface ${name} ${text}\n`
		: `${head}export type ${name} = ${text};\n`;
}

export function refsOf(schema: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(schema)) for (const item of schema) refsOf(item, found);
	else if (schema && typeof schema === "object") {
		for (const [key, value] of Object.entries(schema)) {
			if (key === "$ref" && typeof value === "string") {
				found.add(decodeURIComponent(value.replace("#/$defs/", "")));
			} else refsOf(value, found);
		}
	}
	return found;
}
