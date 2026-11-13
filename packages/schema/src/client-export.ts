import { z } from "zod";
import { harvestDocs } from "./client-docs.js";
import { declaration, docLines, type Json, refsOf, typeText } from "./client-emit.js";
import {
	CONTROL_PLANE_TIME_EVENT,
	CONTROL_PLANE_TIME_HEADER,
	CONTROL_PLANE_VERSION_HEADER,
	type RouteDef,
} from "./http/contract.js";

type Io = "input" | "output";
type Kind = "endpoint" | "stream" | "download";

interface ClientRoute {
	domain: string;
	name: string;
	kind: Kind;
	def: RouteDef;
}

interface Part {
	route: ClientRoute;
	part: "params" | "query" | "body" | "response" | "events";
	event?: string;
	schema: z.ZodType;
	io: Io;
	optional: boolean;
}

export type ClientExport = Record<
	| "src/generated/types.ts"
	| "src/generated/routes.ts"
	| "src/generated/protocol.ts"
	| "test/contract-parity.ts",
	string
>;

const LOW_LEVEL = new Set(["request", "url", "subscribe"]);
const PROTOCOL = {
	CONTROL_PLANE_TIME_HEADER,
	CONTROL_PLANE_VERSION_HEADER,
	CONTROL_PLANE_TIME_EVENT,
};
const HEADER = "// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。\n\n";

const camel = (text: string) => text.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const isVoid = (schema: z.ZodType) => schema._zod.def.type === "undefined";
const partId = (p: Part) =>
	`${p.route.domain}.${p.route.name}.${p.event === undefined ? p.part : `events.${p.event}`}`;
const at = (domain: string, name: string) => `[${JSON.stringify(domain)}][${JSON.stringify(name)}]`;

function selectClientRoutes(apis: Record<string, Record<string, RouteDef>>): ClientRoute[] {
	const routes: ClientRoute[] = [];
	for (const [domain, table] of Object.entries(apis)) {
		if (LOW_LEVEL.has(domain)) throw new Error(`领域名 ${domain} 与 API 客户端的底层入口重名`);
		for (const [name, def] of Object.entries(table)) {
			if ("key" in def && camel(def.key[0] as string) !== domain) {
				throw new Error(`${domain}.${name}: key 的第一段 ${def.key[0]} 与领域名不一致`);
			}
			if (!def.client) continue;
			if ("upload" in def && def.upload) {
				throw new Error(`${domain}.${name}: 上传接口不能进入 API 客户端`);
			}
			const kind = "kind" in def ? def.kind : "endpoint";
			routes.push({ domain, name, kind, def });
		}
	}
	return routes;
}

function partsOf(routes: readonly ClientRoute[]): Part[] {
	const parts: Part[] = [];
	for (const route of routes) {
		const def = route.def;
		const add = (part: Part["part"], schema: z.ZodType, io: Io, optional = false) =>
			parts.push({ route, part, schema, io, optional });
		if (def.params) add("params", def.params, "input");
		if (def.query) add("query", def.query, "input", def.query.safeParse({}).success);
		if ("body" in def && def.body) {
			add("body", def.body, "input", def.body.safeParse(undefined).success);
		}
		if ("response" in def) add("response", def.response, "output");
		if ("events" in def) {
			for (const [event, schema] of Object.entries(def.events)) {
				parts.push({ route, part: "events", event, schema, io: "output", optional: false });
			}
		}
	}
	return parts;
}

interface Converted {
	roots: Map<string, Json>;
	defs: Record<string, Json>;
}

function convert(
	parts: readonly Part[],
	io: Io,
	names: z.core.$ZodRegistry<{ id: string }>,
): Converted {
	const wanted = parts.filter((p) => p.io === io && !isVoid(p.schema));
	const wrapper = z.object(Object.fromEntries(wanted.map((p) => [partId(p), p.schema])));
	const json = z.toJSONSchema(wrapper, { io, target: "draft-2020-12", metadata: names }) as Json;
	const properties = json.properties as Record<string, Json>;
	const defs = (json.$defs ?? {}) as Record<string, Json>;
	return { roots: new Map(wanted.map((p) => [partId(p), properties[partId(p)] as Json])), defs };
}

function inputVariants(input: Converted, output: Converted): Set<string> {
	const variants = new Set<string>();
	for (const [id, def] of Object.entries(input.defs)) {
		const out = output.defs[id];
		if (out && JSON.stringify(out) !== JSON.stringify(def)) variants.add(id);
	}
	for (let grew = true; grew; ) {
		grew = false;
		for (const [id, def] of Object.entries(input.defs)) {
			if (variants.has(id) || !output.defs[id]) continue;
			if ([...refsOf(def)].some((ref) => variants.has(ref))) {
				variants.add(id);
				grew = true;
			}
		}
	}
	return variants;
}

export function buildClientExport(
	apis: Record<string, Record<string, RouteDef>>,
	contract: Record<string, unknown>,
): ClientExport {
	const routes = selectClientRoutes(apis);
	const parts = partsOf(routes);

	const names = z.registry<{ id: string }>();
	for (const [name, value] of Object.entries(contract)) {
		if (value instanceof z.ZodType && !names.has(value)) names.add(value, { id: name });
	}
	const registered = new Set(Object.keys(contract));
	const input = convert(parts, "input", names);
	const output = convert(parts, "output", names);
	for (const id of [...Object.keys(input.defs), ...Object.keys(output.defs)]) {
		if (!registered.has(id)) throw new Error(`未命名的递归 schema ${id}：把它从契约导出`);
	}

	const variants = inputVariants(input, output);
	for (const id of variants) {
		if (registered.has(`${id}Input`)) throw new Error(`生成的 ${id}Input 与契约的导出重名`);
	}
	const nameFor = (io: Io) => (id: string) =>
		io === "input" && variants.has(id) ? `${id}Input` : id;

	const routeAliases = new Map<string, string>();
	for (const [exportName, value] of Object.entries(contract)) {
		if (!value || typeof value !== "object" || value instanceof z.ZodType) continue;
		for (const [name, def] of Object.entries(value)) {
			for (const [domain, table] of Object.entries(apis)) {
				if (table[name] === def) routeAliases.set(`${exportName}.${name}`, `${domain}.${name}`);
			}
		}
	}
	const plain = (doc: string) =>
		doc.replace(/\{@link\s+([^}\s|]+)[^}]*\}/g, (_, target: string) => {
			return `\`${routeAliases.get(target) ?? target}\``;
		});

	const roots = new Map<string, string>();
	const stopAt = new Set<string>();
	for (const id of Object.keys(output.defs)) {
		roots.set(id, `z.output<typeof C.${id}>`);
		stopAt.add(id);
	}
	for (const id of Object.keys(input.defs)) {
		const name = nameFor("input")(id);
		if (roots.has(name)) continue;
		roots.set(name, `NonNullable<z.input<typeof C.${id}>>`);
		stopAt.add(name);
	}
	const contractPart = (p: Part) => {
		const route = `(typeof C.httpApis)${at(p.route.domain, p.route.name)}`;
		if (p.io === "input") return `NonNullable<z.input<${route}[${JSON.stringify(p.part)}]>>`;
		if (p.part === "response") return `z.output<${route}["response"]>`;
		return `z.output<${route}["events"][${JSON.stringify(p.event)}]>`;
	};
	for (const p of parts) if (!isVoid(p.schema)) roots.set(partId(p), contractPart(p));
	const docs = harvestDocs({ roots, stopAt });
	const docFor = (root: string) => (path: readonly string[]) => {
		const text = docs.field(root, path);
		return text === undefined ? undefined : plain(text);
	};
	const exportDoc = (id: string) => {
		const text = docs.exports.get(id);
		return text === undefined ? undefined : plain(text);
	};

	const declarations = new Map<string, string>();
	for (const io of ["output", "input"] as const) {
		const defs = io === "output" ? output.defs : input.defs;
		for (const [id, def] of Object.entries(defs)) {
			const name = nameFor(io)(id);
			if (declarations.has(name)) continue;
			const options = { refName: nameFor(io), doc: docFor(name) };
			declarations.set(name, declaration(name, def, options, exportDoc(id)));
		}
	}
	const types = [...declarations.keys()].sort().map((name) => declarations.get(name));

	const used = new Set<string>();
	const tracked = (io: Io) => (id: string) => {
		const name = nameFor(io)(id);
		used.add(name);
		return name;
	};
	const kinds = { endpoint: "Endpoint", stream: "Stream", download: "Download" } as const;
	const apiLines: string[] = [];
	const tableLines: string[] = [];
	for (const domain of [...new Set(routes.map((r) => r.domain))]) {
		apiLines.push(`\t${domain}: {`);
		tableLines.push(`\t${domain}: {`);
		for (const route of routes.filter((r) => r.domain === domain)) {
			const own = parts.filter((p) => p.route === route);
			const typeOf = (p: Part, indent: string) =>
				isVoid(p.schema)
					? "void"
					: typeText(
							(p.io === "input" ? input : output).roots.get(partId(p)),
							{
								refName: tracked(p.io),
								doc: docFor(partId(p)),
							},
							indent,
						);
			const fields = own
				.filter((p) => p.io === "input")
				.map((p) => `\t\t\t\t${p.part}${p.optional ? "?" : ""}: ${typeOf(p, "\t\t\t\t")};`);
			const args = [fields.length === 0 ? "{}" : `{\n${fields.join("\n")}\n\t\t\t}`];
			if (route.kind === "endpoint") {
				args.push(typeOf(own.find((p) => p.part === "response") as Part, "\t\t\t"));
			} else if (route.kind === "stream") {
				const events = own
					.filter((p) => p.part === "events")
					.map((p) => `\t\t\t\t${p.event}: ${typeOf(p, "\t\t\t\t")};`);
				args.push(`{\n${events.join("\n")}\n\t\t\t}`);
			}
			const routeDoc = docs.routes.get(`${domain}.${route.name}`);
			const doc = [`\`${route.def.method} ${route.def.path}\``];
			if (routeDoc) doc.push("", plain(routeDoc));
			apiLines.push(...docLines(doc.join("\n"), "\t\t"));
			apiLines.push(
				`\t\t${route.name}: ${kinds[route.kind]}<\n${args.map((a) => `\t\t\t${a}`).join(",\n")}\n\t\t>;`,
			);
			tableLines.push(
				`\t\t${route.name}: { method: ${JSON.stringify(route.def.method)}, path: ${JSON.stringify(route.def.path)}, kind: ${JSON.stringify(route.kind)} },`,
			);
		}
		apiLines.push("\t};");
		tableLines.push("\t},");
	}
	const kindImports = [...new Set(routes.map((r) => kinds[r.kind]))];
	const routesFile = [
		HEADER.trimEnd(),
		"",
		`import type { ${[...kindImports, "RouteTable"].sort().join(", ")} } from "../route.js";`,
		...(used.size === 0
			? []
			: [
					`import type {\n${[...used]
						.sort()
						.map((n) => `\t${n},`)
						.join("\n")}\n} from "./types.js";`,
				]),
		"",
		`export interface Api {\n${apiLines.join("\n")}\n}`,
		"",
		`export const routes = {\n${tableLines.join("\n")}\n} as const satisfies RouteTable<Api>;`,
		"",
	].join("\n");

	const protocolFile =
		HEADER +
		Object.entries(PROTOCOL)
			.map(([name, value]) => {
				const doc = exportDoc(name);
				return `${doc ? `${docLines(doc, "").join("\n")}\n` : ""}export const ${name} = ${JSON.stringify(value)};\n`;
			})
			.join("\n");

	const checks = parts.flatMap((p) => {
		const generated = `Api${at(p.route.domain, p.route.name)}`;
		const route = `Apis${at(p.route.domain, p.route.name)}`;
		if (p.io === "input") {
			const gen = `NonNullable<${generated}["input"][${JSON.stringify(p.part)}]>`;
			return [`Within<${gen}, NonNullable<z.input<${route}[${JSON.stringify(p.part)}]>>>`];
		}
		if (isVoid(p.schema)) return [];
		if (p.part === "response")
			return [`Equal<${generated}["output"], z.output<${route}["response"]>>`];
		const event = JSON.stringify(p.event);
		return [`Equal<${generated}["events"][${event}], z.output<${route}["events"][${event}]>>`];
	});
	const parityFile = [
		HEADER.trimEnd(),
		"// 生成的类型与契约自己的 z.input / z.output 一致：请求不宽于 z.input，响应与事件和 z.output 相同。",
		"",
		'import type * as C from "@sfly/schema";',
		'import type { z } from "zod";',
		'import type { Api } from "../src/generated/routes.js";',
		"",
		"type Apis = typeof C.httpApis;",
		"type Within<A, B> = [A] extends [B] ? true : false;",
		"type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;",
		"type Expect<T extends true> = T;",
		"",
		"export type ContractParity = [",
		...checks.map((check) => `\tExpect<${check}>,`),
		"];",
		"",
	].join("\n");

	return {
		"src/generated/types.ts": HEADER + types.join("\n"),
		"src/generated/routes.ts": routesFile,
		"src/generated/protocol.ts": protocolFile,
		"test/contract-parity.ts": parityFile,
	};
}
