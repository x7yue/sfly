import { z } from "zod";

/**
 * HTTP API 契约（ADR 0007）：每个接口在这里用 zod 定义一份请求与响应 schema，
 * 控制面用它校验请求、约束响应（apps/server/src/http/contract-route.ts），
 * 前端用它推导类型、拼路径、生成 query key，并在开发环境校验响应（apps/web/src/lib/api.ts）。
 *
 * 约定（新增接口照此编写，见 docs/DESIGN-SYSTEM.md「HTTP 契约」一节）：
 *
 * 1. 一个领域一个模块（`http/agents.ts`、`http/packages.ts`…），导出该领域的数据 schema
 *    （名词，如 `AgentView`）和接口表（`agentsApi = { list: endpoint({...}) }`）。
 * 2. 字段名与 JSON 一致，用 snake_case；时间用 `Timestamp`（ISO 8601 字符串）。
 * 3. 响应 schema 只描述形状：用 `z.object`（不用 strict，允许控制面先加字段），
 *    不用 transform / default / coerce——生产环境前端不解析响应，解析前后必须相同。
 * 4. 请求（params / query / body）可以用 coerce、default；控制面拿到的是解析后的值，
 *    校验失败统一返回 400 `invalid_request`，`details` 为 zod 的 issues。
 *    含 NUL（`\u0000`）的输入由控制面在校验前统一拦下：路径参数 404 `not_found`，查询参数与 JSON 请求体 400 `invalid_request`。
 * 5. `key` 是 TanStack Query 的 query key 前缀，第一段是领域名；前端一律用 `queryKey()` 生成，
 *    失效时用 `domainKey(def)`（领域前缀，如 `["packages"]`）让该领域的查询全部重新获取。
 * 6. 错误响应统一为 `ApiErrorBody`。请求校验失败默认是 400 `invalid_request`；需要更具体的错误码时
 *    （例如保存版本的 `base_version_required`）用 `requestError` 按原始请求选出错误码，details 仍是 zod issues。
 * 7. 控制面的每个 HTTP 路由都在契约里（控制面启动时检查，apps/server/src/http/contract-route.ts）：
 *    JSON 接口用 `endpoint`；SSE 用 `stream`（`events` 是事件名 → data 的 schema）；
 *    返回字节流的下载用 `download`。请求体是原始字节的上传（发布节点包、上传产物）用 `endpoint`，
 *    不定义 body，只约束路径参数与 JSON 响应。新增领域模块后加进 ./index.ts 的 `httpContract`。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 请求校验失败时的错误码与说明。 */
export interface RequestErrorInfo {
	code: string;
	message: string;
}

/** 未解析的原始请求（控制面收到的 params / query / body）。 */
export interface RawRequest {
	params: unknown;
	query: unknown;
	body: unknown;
}

interface RouteDefBase {
	/**
	 * Fastify 风格的路径模板，路径参数写作 `:name`，末尾的 `*` 匹配剩余路径（参数名为 `*`）；
	 * 不含浏览器侧的 `/api` 前缀。
	 */
	path: string;
	params?: z.ZodType;
	query?: z.ZodType;
	/**
	 * 请求不符合契约时用更具体的错误码（默认 400 `invalid_request`）；返回 undefined 用默认值。
	 * details 总是 zod issues。
	 */
	requestError?: (request: RawRequest) => RequestErrorInfo | undefined;
	/**
	 * 给 curl 等非浏览器客户端的原文与下载（用户文档原文、install.sh、Agent 二进制、sfly 简单索引）：
	 * 浏览器导航到这个路径时也直接返回它，不回退到前端入口页（apps/server/src/http/web-app.ts）。
	 */
	raw?: true;
}

/** JSON 接口。 */
export interface EndpointDef extends RouteDefBase {
	method: HttpMethod;
	/** query key 前缀，第一段是领域名。 */
	key: readonly string[];
	body?: z.ZodType;
	response: z.ZodType;
}

/** SSE 推送（GET）：每条消息都有事件名，data 是 JSON。 */
export interface StreamDef extends RouteDefBase {
	method: "GET";
	kind: "stream";
	/** 事件名 → data 的 schema（与响应一样只描述形状，不做转换）。 */
	events: Record<string, z.ZodType>;
}

/** 返回字节流的下载（GET）；错误时仍是 JSON 的 ApiErrorBody。 */
export interface DownloadDef extends RouteDefBase {
	method: "GET";
	kind: "download";
	/** 成功时响应的 content-type。 */
	contentType: string;
}

export type RouteDef = EndpointDef | StreamDef | DownloadDef;

/** 定义一个接口（只做类型推断，原样返回）。 */
export const endpoint = <const E extends EndpointDef>(def: E): E => def;

/** 定义一个 SSE 推送。 */
export const stream = <const S extends Omit<StreamDef, "method" | "kind">>(
	def: S,
): S & { method: "GET"; kind: "stream" } => ({ ...def, method: "GET", kind: "stream" });

/** 定义一个下载。 */
export const download = <const D extends Omit<DownloadDef, "method" | "kind">>(
	def: D,
): D & { method: "GET"; kind: "download" } => ({ ...def, method: "GET", kind: "download" });

/** SSE 推送的事件：事件名 → data 的类型。 */
export type StreamEvents<S extends StreamDef> = {
	[K in keyof S["events"] & string]: z.output<S["events"][K]>;
};

type Part<E, K extends "params" | "query" | "body", IO extends "in" | "out"> = E extends {
	[P in K]: infer S extends z.ZodType;
}
	? IO extends "in"
		? z.input<S>
		: z.output<S>
	: undefined;

/** 调用方传入的请求（解析前）：没有定义的部分不需要传。 */
export type EndpointInput<E extends RouteDef> = OmitUndefined<{
	params: Part<E, "params", "in">;
	query: Part<E, "query", "in">;
	body: Part<E, "body", "in">;
}>;

/** 控制面拿到的请求（解析后）。 */
export type EndpointRequest<E extends RouteDef> = {
	params: Part<E, "params", "out">;
	query: Part<E, "query", "out">;
	body: Part<E, "body", "out">;
};

/** 响应类型；响应 schema 不做转换（约定 3），输入输出相同。 */
export type EndpointResponse<E extends EndpointDef> = z.output<E["response"]>;

type OmitUndefined<T> = { [K in keyof T as T[K] extends undefined ? never : K]: T[K] };

/** 统一的错误响应 `{ error: { code, message, details? } }`。 */
export const ApiErrorBody = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** 时间：ISO 8601 字符串（控制面用 `Date#toISOString()` 输出）。 */
export const Timestamp = z.iso.datetime();

/**
 * 控制面时间（GLOSSARY「时间」，ADR 0018）：控制面把自己的当前时间带给页面，页面据此修正浏览器时间，
 * "已运行"等时长才不依赖浏览器时钟（apps/web/src/lib/control-plane-time.ts）。
 *
 * - 每个 HTTP 响应都带 {@link CONTROL_PLANE_TIME_HEADER} 响应头，值是 `Timestamp`。
 * - 每条 SSE 流在连上时和每次心跳都发一条 {@link CONTROL_PLANE_TIME_EVENT} 事件，data 是 {@link ControlPlaneTimeEvent}。
 *   它由控制面统一发送，不写进各个 `stream` 的 `events`。
 */
export const CONTROL_PLANE_TIME_HEADER = "x-sfly-time";
export const CONTROL_PLANE_TIME_EVENT = "time";
export const ControlPlaneTimeEvent = z.object({ time: Timestamp });
export type ControlPlaneTimeEvent = z.infer<typeof ControlPlaneTimeEvent>;

/**
 * 控制面版本：每个 HTTP 响应（含错误响应和 SSE 流）都带 {@link CONTROL_PLANE_VERSION_HEADER} 响应头，
 * 值是控制面的版本号（Agent、SDK 与控制面同版本，ADR 0010）。`sfly` 命令行据此在版本不一致时告警。
 */
export const CONTROL_PLANE_VERSION_HEADER = "x-sfly-version";

/**
 * 按路径模板拼出路径；路径参数用 encodeURIComponent 编码，末尾 `*` 的值按 `/` 分段、每段单独编码。
 */
export function pathFor(def: Pick<RouteDef, "path">, params?: Record<string, unknown>): string {
	const value = (name: string) => {
		const v = params?.[name];
		if (v === undefined || v === null) throw new Error(`缺少路径参数 ${name}（${def.path}）`);
		return String(v);
	};
	return def.path
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => encodeURIComponent(value(name)))
		.replace(/\*$/, () => value("*").split("/").map(encodeURIComponent).join("/"));
}

/** 领域前缀（query key 的第一段）：让这个领域的查询全部失效时用，例如 `domainKey(runsApi.get)` → `["runs"]`。 */
export const domainKey = (def: EndpointDef) => [def.key[0] as string] as const;

/** 接口的 query key：`[...key, { params?, query? }]`，同一请求总是得到相同的 key。 */
export function queryKey<E extends EndpointDef>(def: E, input?: EndpointInput<E>) {
	const { params, query } = (input ?? {}) as { params?: unknown; query?: unknown };
	const vars = {
		...(params === undefined ? {} : { params }),
		...(query === undefined ? {} : { query }),
	};
	return [...def.key, vars] as const;
}
