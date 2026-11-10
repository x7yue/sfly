import {
	CONTROL_PLANE_TIME_HEADER,
	type DownloadDef,
	type EndpointDef,
	type EndpointInput,
	type EndpointResponse,
	pathFor,
	queryKey,
	type RouteDef,
	type StreamDef,
} from "@sfly/schema";
import { queryOptions } from "@tanstack/react-query";
import { observeControlPlaneTime } from "./control-plane-time";
import { getNickname, NICKNAME_HEADER } from "./nickname";

/**
 * 控制面 HTTP API 客户端。浏览器请求同源的 `/api/*`：生产环境由控制面直接处理（去掉前缀后
 * 按原路由处理，见 apps/server/src/http/web-app.ts），开发时由 vite 原样代理到控制面（vite.config.ts）。
 * 每个请求都带上浏览器昵称请求头；每个响应带回控制面时间，页面上的"现在"由它得出（./control-plane-time.ts）。
 *
 * 所有请求都走契约（@sfly/schema 的 http 模块，ADR 0007），没有手写的接口函数和类型：
 *
 *   const agents = useQuery(apiQuery(agentsApi.list));                           // 查询
 *   await callApi(packagesApi.version, { params: { name, version } });         // 直接调用
 *   queryClient.invalidateQueries({ queryKey: domainKey(packagesApi.list) });   // 按领域失效
 *   <a href={apiUrl(logsApi.download, { params: { id } })}>                     // 下载链接
 *   useEventSource(runsApi.events, { params: { id } }, { run: (view) => … });  // SSE（./sse.ts）
 *
 * 类型由契约推导，开发环境（vite dev）下响应会按契约解析，不符合时抛出 code 为
 * `contract_violation` 的 ApiError（页面上显示为错误状态，details 是 zod issues）。
 */
export const API_BASE = "/api";

/** 控制面的错误响应 `{ error: { code, message, details? } }`；method / path 用于错误详情。 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
		readonly method?: string,
		readonly path?: string,
	) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await respond(method, path, body, "application/json");
	// 204 没有响应体（契约的响应 schema 为 z.undefined()）。
	return (res.status === 204 ? undefined : await res.json()) as T;
}

/** 发出请求；失败（网络错误或非 2xx）时抛出 ApiError。 */
async function respond(
	method: string,
	path: string,
	body: unknown,
	accept: string,
): Promise<Response> {
	let res: Response;
	const headers: Record<string, string> = { accept };
	const nickname = getNickname();
	if (nickname) headers[NICKNAME_HEADER] = encodeURIComponent(nickname);
	if (body !== undefined) headers["content-type"] = "application/json";
	try {
		res = await fetch(`${API_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		throw new ApiError(0, "network_error", "无法连接控制面", String(error), method, path);
	}
	// 响应头一到就记下控制面时间（./control-plane-time.ts），不等响应体下载完。
	observeControlPlaneTime(res.headers.get(CONTROL_PLANE_TIME_HEADER));
	if (!res.ok) {
		const parsed = (await res.json().catch(() => null)) as {
			error?: { code?: string; message?: string; details?: unknown };
		} | null;
		const error = parsed?.error;
		throw new ApiError(
			res.status,
			error?.code ?? "http_error",
			error?.message ?? `HTTP ${res.status}`,
			error?.details,
			method,
			path,
		);
	}
	return res;
}

/** 按契约调用接口（约定见 packages/schema/src/http/contract.ts）。 */
export function callApi<E extends EndpointDef>(
	def: E,
	...[input]: InputArgs<E>
): Promise<EndpointResponse<E>> {
	return send(def, input);
}

/** 没有 params / query / body 的接口不需要传第二个参数。 */
export type InputArgs<E extends RouteDef> = keyof EndpointInput<E> extends never
	? []
	: [EndpointInput<E>];

/** 浏览器访问的完整路径（带 `/api` 前缀与查询参数）：下载链接、EventSource 用。 */
export function apiUrl<D extends DownloadDef | StreamDef>(
	def: D,
	...[input]: InputArgs<D>
): string {
	const { params, query } = (input ?? {}) as {
		params?: Record<string, unknown>;
		query?: Record<string, unknown>;
	};
	const search = query ? `?${new URLSearchParams(toSearch(query))}` : "";
	return `${API_BASE}${pathFor(def, params)}${search}`.replace(/\?$/, "");
}

async function send<E extends EndpointDef>(
	def: E,
	input: EndpointInput<E> | undefined,
): Promise<EndpointResponse<E>> {
	const { params, query, body } = (input ?? {}) as {
		params?: Record<string, unknown>;
		query?: Record<string, unknown>;
		body?: unknown;
	};
	const search = query ? `?${new URLSearchParams(toSearch(query))}` : "";
	const path = `${pathFor(def, params)}${search}`;
	const data = await request<unknown>(def.method, path, body);
	if (import.meta.env.DEV) {
		const parsed = def.response.safeParse(data);
		if (!parsed.success) {
			throw new ApiError(
				200,
				"contract_violation",
				`响应不符合接口契约（${def.method} ${def.path}）`,
				parsed.error.issues,
				def.method,
				path,
			);
		}
	}
	return data as EndpointResponse<E>;
}

const toSearch = (query: Record<string, unknown>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(query)
			.filter(([, v]) => v !== undefined && v !== null)
			.map(([k, v]) => [k, String(v)]),
	);

/**
 * 契约接口的 TanStack Query 选项：query key 由 `queryKey(def, input)` 统一生成，
 * 同一接口、同一参数在各处共享缓存。额外选项（refetchInterval、enabled…）在调用处展开覆盖。
 */
export function apiQuery<E extends EndpointDef>(def: E, ...[input]: InputArgs<E>) {
	return queryOptions({
		queryKey: queryKey(def, input),
		queryFn: () => send(def, input),
	});
}

/**
 * 下载接口的文本内容作为查询（例如用户文档的 Markdown 原文，docsApi.page）。
 * 下载接口没有 query key 前缀，key 是 `["download", 路径模板, { params?, query? }]`。
 */
export function apiTextQuery<D extends DownloadDef>(def: D, ...[input]: InputArgs<D>) {
	const { params, query } = (input ?? {}) as { params?: unknown; query?: unknown };
	const url = apiUrl(def, ...([input] as InputArgs<D>));
	return queryOptions({
		queryKey: ["download", def.path, { params, query }] as const,
		queryFn: async () =>
			(await respond("GET", url.slice(API_BASE.length), undefined, def.contentType)).text(),
	});
}
