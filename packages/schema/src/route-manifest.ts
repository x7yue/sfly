import { z } from "zod";
import { annotateSchema, type FieldDocs, type RouteDocPart } from "./field-docs.js";
import {
	type Effect,
	type EndpointDef,
	RESOURCE_KIND_LABELS,
	type ResourceKind,
	type ResourceRef,
	type RouteDef,
} from "./http/contract.js";
import {
	checkDeclarationTables,
	checkRouteDeclarations,
	DECLARATION_RULES,
	type DeclarationRules,
} from "./http/declarations.js";

/**
 * 路由清单：从 HTTP 契约导出的接口列表（方法、路径、key、种类、说明、只读还是有副作用、作用在哪类资源上，
 * 以及 params / query / body / 响应的 JSON Schema），
 * 随 Python SDK 打包（`sdk/python/src/sfly/schemas/routes.json`，由 scripts/export-json-schema.ts 生成），
 * `sfly api` 用它列出接口、说明接口（`--describe`）并在发请求前校验。
 *
 * 请求的 JSON Schema 按输入方向导出（客户端发出什么，`z.toJSONSchema` 的 `io: "input"`）：带默认值的字段可以省略，
 * 转换（transform / preprocess / pipe）只导出转换前的输入。refine 与转换后的约束 JSON Schema 表达不了，
 * 导出时不报错、也不丢掉这个事实：每处都记在该路由的 `notes` 里，由控制面校验，清单只做第一道检查。
 *
 * 响应（`response`，SSE 的每个事件在 `events`）按输出方向导出，每个路由的 schema 自成一体（不引用别的路由）。
 * 响应约定只描述形状、不做转换（契约约定 3），控制面可以先加字段：对象不带 `additionalProperties: false`。
 */

export type RouteKind = "endpoint" | "stream" | "download" | "upload";

export type RoutePart = "params" | "query" | "body";

/** 导出时没能带进 JSON Schema 的约束。 */
export interface RouteNote {
	part: RoutePart;
	/** 字段路径，`a.b`、数组元素写 `[]`；整个对象的约束为 `""`。 */
	path: string;
	reason: string;
}

export interface RouteManifestEntry {
	method: string;
	/** Fastify 风格的路径模板，`:name` 是路径参数，末尾的 `*` 匹配剩余路径；不含 `/api` 前缀。 */
	path: string;
	/** query key（只有 JSON 接口有；SSE 与下载为 null）。 */
	key: readonly string[] | null;
	/**
	 * `endpoint` 普通 JSON 接口；`stream` SSE；`download` 返回字节流；
	 * `upload` 请求体是原始字节（没有 body 的 JSON Schema，只约束路径参数）。
	 */
	kind: RouteKind;
	/** 一句话说明这个接口做什么。 */
	summary: string;
	/** `read` 只读（不改变任何资源的内容，也没有平台之外的副作用）；`write` 有副作用。 */
	effect: Effect;
	/** 作用在哪类资源上，以及用请求的哪个字段定位到具体的那一个（契约的 `ResourceRef`）。 */
	resource: ResourceRef;
	/** 新建的是哪类资源：有这个字段时，`resource` 定位到的资源只被读，写落在新建出来的资源上。 */
	creates?: ResourceKind;
	/** 让 `resource` 定位到的资源（或它的一部分）不再可用：删除、归档。 */
	removes?: true;
	/** 下载成功时的 content-type。 */
	content_type?: string;
	params?: Record<string, unknown>;
	query?: Record<string, unknown>;
	body?: Record<string, unknown>;
	/** 成功时响应体的 JSON Schema（普通接口和上传）；没有这个字段表示响应没有 JSON 体（204 或下载、SSE）。 */
	response?: Record<string, unknown>;
	/** SSE：事件名 → 该事件 data 的 JSON Schema。每条流都另外带控制面时间的 `time` 事件，不在这里。 */
	events?: Record<string, Record<string, unknown>>;
	notes: RouteNote[];
}

export interface RouteManifest {
	/** 清单格式的说明，随文件一起给读的人。 */
	description: string;
	/** 资源类别 → 中文名（`resource.kind` 的取值）。 */
	resource_kinds: Record<ResourceKind, string>;
	routes: RouteManifestEntry[];
}

const DESCRIPTION =
	"sfly 控制面的 HTTP 接口清单，由 packages/schema 的 HTTP 契约导出（不要手改，pnpm gen 重新生成）。" +
	"summary 是一句话说明；effect 是 read（只读：不改变平台里任何资源的内容，也不在平台之外产生副作用；" +
	"只写访问日志这类不影响资源内容的痕迹也算）或 write（有副作用）；" +
	"resource 是接口作用在哪类资源上（kind，取值见 resource_kinds），以及用请求的哪个字段定位到具体的那一个（target：" +
	"{params: 路径参数名}、{query: 查询参数名}、{body: 请求体字段名}；collection 是列表或新建，没有具体的那一个；" +
	"upload 是具体的那一个在上传的内容里；global 是平台自身）；" +
	"有 creates 的接口新建一个这类资源，这时 resource 定位到的资源只被读、写落在新建出来的资源上；" +
	"有 removes 的接口让 resource 定位到的资源（或它的一部分）不再可用（删除、归档）。" +
	"params、query、body 是请求的 JSON Schema（draft 2020-12，按输入方向导出）；" +
	"query 的值在 URL 里总是文本，integer、number、boolean 表示文本要能解析成它。" +
	"response 是成功响应体的 JSON Schema（按输出方向导出，控制面以后可以加字段，所以对象不是封闭的），" +
	"events 是 SSE 每个事件的 data 的 JSON Schema，没有这两个字段的接口没有 JSON 响应体。" +
	"notes 记录 JSON Schema 表达不了的约束（自定义校验、转换），那些只由控制面校验。";

/**
 * `refine` 的 `params` 里带上它，表示这条检查在导出的 JSON Schema 里有等价的约束（`maxLength`、`pattern`），
 * 不记进 `notes`。
 */
export const MIRRORED_IN_JSON_SCHEMA = { mirroredInJsonSchema: true } as const;

const REASON_CUSTOM = "自定义校验（refine）不在 JSON Schema 里，由控制面校验";
const REASON_PIPE =
	"含转换（transform、preprocess、pipe），JSON Schema 只描述转换前的输入，转换后的约束由控制面校验";

function dottedPath(path: readonly (string | number)[]): string {
	const out: string[] = [];
	for (const segment of path) {
		if (segment === "properties") continue;
		if (segment === "items") out.push("[]");
		else out.push(String(segment));
	}
	return out.join(".").replaceAll(".[]", "[]");
}

function isMirrored(check: { _zod: { def: object } }): boolean {
	const params = (check._zod.def as { params?: { mirroredInJsonSchema?: unknown } }).params;
	return params?.mirroredInJsonSchema === true;
}

function customMessage(check: { _zod: { def: { error?: unknown } } }): string | undefined {
	const error = check._zod.def.error;
	if (typeof error !== "function") return undefined;
	try {
		const message: unknown = error({});
		return typeof message === "string" ? message : undefined;
	} catch {
		return undefined;
	}
}

/** 导出一个请求部分的 JSON Schema（输入方向），同时收集没能带进去的约束。 */
function exportPart(
	part: RoutePart,
	schema: z.ZodType,
	notes: Map<string, RouteNote>,
): Record<string, unknown> {
	const note = (path: string, reason: string) => {
		notes.set(`${part}\0${path}\0${reason}`, { part, path, reason });
	};
	return exportSchema(schema, "input", (ctx, where) => {
		const def = ctx.zodSchema._zod.def;
		if (def.type === "pipe" || def.type === "transform") note(where, REASON_PIPE);
		for (const check of def.checks ?? []) {
			if (check._zod.def.check !== "custom") continue;
			if (isMirrored(check)) continue;
			const message = customMessage(check);
			note(where, message ? `${REASON_CUSTOM}：${message}` : REASON_CUSTOM);
		}
	});
}

/**
 * 导出响应（或 SSE 事件 data）的 JSON Schema，按输出方向：只描述形状，不记 `notes`（响应不做校验，契约约定 3）。
 * zod 把没写 strict 的对象导成封闭的（`additionalProperties: false`），而响应允许控制面先加字段，
 * 所以去掉它；写了 `strictObject` 的（场景文档）保留。
 */
function exportResponse(schema: z.ZodType): Record<string, unknown> {
	return exportSchema(schema, "output", (ctx) => {
		const def = ctx.zodSchema._zod.def;
		if (def.type === "object" && !def.catchall) delete ctx.jsonSchema.additionalProperties;
	});
}

type OverrideContext = Parameters<NonNullable<z.core.JSONSchemaGeneratorParams["override"]>>[0];

function exportSchema(
	schema: z.ZodType,
	io: "input" | "output",
	visit: (ctx: OverrideContext, where: string) => void,
): Record<string, unknown> {
	const json = z.toJSONSchema(schema, {
		io,
		target: "draft-2020-12",
		override(ctx) {
			visit(ctx, dottedPath(ctx.path));
		},
	}) as Record<string, unknown>;
	delete json.$schema;
	return json;
}

/** 响应没有 JSON 体（204）：schema 是 `z.undefined()`。 */
const hasNoBody = (schema: z.ZodType) => schema._zod.def.type === "undefined";

function kindOf(def: RouteDef): RouteKind {
	if ("kind" in def) return def.kind;
	return (def as EndpointDef).upload ? "upload" : "endpoint";
}

/**
 * 从契约导出路由清单（顺序与契约一致）。接口声明（说明、只读还是有副作用、资源）有问题时抛错，不导出：
 * 类型保证写了，这里保证写得对（`checkRouteDeclarations`）。
 */
export function buildRouteManifest(
	contract: readonly RouteDef[],
	rules: DeclarationRules = DECLARATION_RULES,
	docs?: FieldDocs,
): RouteManifest {
	const problems = [
		...checkRouteDeclarations(contract, rules),
		...checkDeclarationTables(contract, rules),
	];
	if (problems.length > 0) {
		throw new Error(`HTTP 契约里有接口的声明不对：\n${problems.map((p) => `  ${p}`).join("\n")}`);
	}
	const routes = contract.map((def): RouteManifestEntry => {
		const notes = new Map<string, RouteNote>();
		const entry: Omit<RouteManifestEntry, "notes"> = {
			method: def.method,
			path: def.path,
			key: "key" in def ? def.key : null,
			kind: kindOf(def),
			summary: def.summary,
			effect: def.effect,
			resource: def.resource,
		};
		if (def.creates !== undefined) entry.creates = def.creates;
		if (def.removes !== undefined) entry.removes = def.removes;
		if ("contentType" in def) entry.content_type = def.contentType;
		/** 字段说明：zod 的 `.describe()` 已经在里面，没有的用契约源码里字段上的注释（`docs`）。 */
		const annotated = <T extends Record<string, unknown>>(json: T, part: RouteDocPart): T => {
			if (docs) annotateSchema(json, (path) => docs(def, part, path));
			return json;
		};
		if (def.params) entry.params = annotated(exportPart("params", def.params, notes), "params");
		if (def.query) entry.query = annotated(exportPart("query", def.query, notes), "query");
		if ("body" in def && def.body) {
			entry.body = annotated(exportPart("body", def.body, notes), "body");
		}
		if ("response" in def && !hasNoBody(def.response)) {
			entry.response = annotated(exportResponse(def.response), "response");
		}
		if ("events" in def) {
			entry.events = Object.fromEntries(
				Object.entries(def.events).map(([name, schema]) => [
					name,
					annotated(exportResponse(schema), { event: name }),
				]),
			);
		}
		return { ...entry, notes: [...notes.values()] };
	});
	return { description: DESCRIPTION, resource_kinds: { ...RESOURCE_KIND_LABELS }, routes };
}
