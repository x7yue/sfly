import { z } from "zod";
import type { EndpointDef, RouteDef } from "./http/contract.js";

/**
 * 路由清单：从 HTTP 契约导出的接口列表（方法、路径、key、种类，以及 params / query / body 的 JSON Schema），
 * 随 Python SDK 打包（`sdk/python/src/sfly/schemas/routes.json`，由 scripts/export-json-schema.ts 生成），
 * `sfly api` 用它列出接口并在发请求前校验。
 *
 * JSON Schema 按输入方向导出（客户端发出什么，`z.toJSONSchema` 的 `io: "input"`）：带默认值的字段可以省略，
 * 转换（transform / preprocess / pipe）只导出转换前的输入。refine 与转换后的约束 JSON Schema 表达不了，
 * 导出时不报错、也不丢掉这个事实：每处都记在该路由的 `notes` 里，由控制面校验，清单只做第一道检查。
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
	/** 下载成功时的 content-type。 */
	content_type?: string;
	params?: Record<string, unknown>;
	query?: Record<string, unknown>;
	body?: Record<string, unknown>;
	notes: RouteNote[];
}

export interface RouteManifest {
	/** 清单格式的说明，随文件一起给读的人。 */
	description: string;
	routes: RouteManifestEntry[];
}

const DESCRIPTION =
	"sfly 控制面的 HTTP 接口清单，由 packages/schema 的 HTTP 契约导出（不要手改，pnpm gen 重新生成）。" +
	"params、query、body 是请求的 JSON Schema（draft 2020-12，按输入方向导出）；" +
	"query 的值在 URL 里总是文本，integer、number、boolean 表示文本要能解析成它。" +
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

/** 导出一个请求部分的 JSON Schema，同时收集没能带进去的约束。 */
function exportPart(
	part: RoutePart,
	schema: z.ZodType,
	notes: Map<string, RouteNote>,
): Record<string, unknown> {
	const note = (path: string, reason: string) => {
		notes.set(`${part}\0${path}\0${reason}`, { part, path, reason });
	};
	const json = z.toJSONSchema(schema, {
		io: "input",
		target: "draft-2020-12",
		override(ctx) {
			const where = dottedPath(ctx.path);
			const def = ctx.zodSchema._zod.def;
			if (def.type === "pipe" || def.type === "transform") note(where, REASON_PIPE);
			for (const check of def.checks ?? []) {
				if (check._zod.def.check !== "custom") continue;
				if (isMirrored(check)) continue;
				const message = customMessage(check);
				note(where, message ? `${REASON_CUSTOM}：${message}` : REASON_CUSTOM);
			}
		},
	}) as Record<string, unknown>;
	delete json.$schema;
	return json;
}

function kindOf(def: RouteDef): RouteKind {
	if ("kind" in def) return def.kind;
	return (def as EndpointDef).upload ? "upload" : "endpoint";
}

/** 从契约导出路由清单（顺序与契约一致）。 */
export function buildRouteManifest(contract: readonly RouteDef[]): RouteManifest {
	const routes = contract.map((def): RouteManifestEntry => {
		const notes = new Map<string, RouteNote>();
		const entry: Omit<RouteManifestEntry, "notes"> = {
			method: def.method,
			path: def.path,
			key: "key" in def ? def.key : null,
			kind: kindOf(def),
		};
		if ("contentType" in def) entry.content_type = def.contentType;
		if (def.params) entry.params = exportPart("params", def.params, notes);
		if (def.query) entry.query = exportPart("query", def.query, notes);
		if ("body" in def && def.body) entry.body = exportPart("body", def.body, notes);
		return { ...entry, notes: [...notes.values()] };
	});
	return { description: DESCRIPTION, routes };
}
