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

export class UnsupportedSchema extends Error {
	constructor(where: string, reason: string) {
		super(`${where}: ${reason}`);
		this.name = "UnsupportedSchema";
	}
}

export interface EmitOptions {
	refName: (id: string) => string;
	doc?: (path: readonly string[]) => string | undefined;
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
	for (const combiner of ["anyOf", "oneOf"] as const) {
		const members = json[combiner];
		if (Array.isArray(members)) return union(members.map((member) => recur(member)));
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
