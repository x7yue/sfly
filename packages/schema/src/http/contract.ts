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
 * 5. `key` 是 TanStack Query 的 query key 前缀，第一段是领域名；前端一律用 `queryKey()` 生成，
 *    失效时用领域前缀（如 `["packages"]`）让该领域的查询全部重新获取。
 * 6. 错误响应统一为 `ApiErrorBody`。非 JSON 的接口（上传、下载归档）不放进契约或只约束 JSON 部分。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EndpointDef {
	method: HttpMethod;
	/** Fastify 风格的路径模板，路径参数写作 `:name`；不含浏览器侧的 `/api` 前缀。 */
	path: string;
	/** query key 前缀，第一段是领域名。 */
	key: readonly string[];
	params?: z.ZodType;
	query?: z.ZodType;
	body?: z.ZodType;
	response: z.ZodType;
}

/** 定义一个接口（只做类型推断，原样返回）。 */
export const endpoint = <const E extends EndpointDef>(def: E): E => def;

type Part<E, K extends "params" | "query" | "body", IO extends "in" | "out"> = E extends {
	[P in K]: infer S extends z.ZodType;
}
	? IO extends "in"
		? z.input<S>
		: z.output<S>
	: undefined;

/** 调用方传入的请求（解析前）：没有定义的部分不需要传。 */
export type EndpointInput<E extends EndpointDef> = OmitUndefined<{
	params: Part<E, "params", "in">;
	query: Part<E, "query", "in">;
	body: Part<E, "body", "in">;
}>;

/** 控制面拿到的请求（解析后）。 */
export type EndpointRequest<E extends EndpointDef> = {
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

/** 按路径模板拼出路径；路径参数用 encodeURIComponent 编码。 */
export function pathFor(def: EndpointDef, params?: Record<string, unknown>): string {
	return def.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
		const value = params?.[name];
		if (value === undefined || value === null)
			throw new Error(`缺少路径参数 ${name}（${def.path}）`);
		return encodeURIComponent(String(value));
	});
}

/** 接口的 query key：`[...key, { params?, query? }]`，同一请求总是得到相同的 key。 */
export function queryKey<E extends EndpointDef>(def: E, input?: EndpointInput<E>) {
	const { params, query } = (input ?? {}) as { params?: unknown; query?: unknown };
	const vars = {
		...(params === undefined ? {} : { params }),
		...(query === undefined ? {} : { query }),
	};
	return [...def.key, vars] as const;
}
