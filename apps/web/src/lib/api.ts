import { ApiError, createClient, type RouteInput } from "@sfly/client";
import {
	type DownloadDef,
	type EndpointDef,
	type EndpointInput,
	type EndpointResponse,
	queryKey,
	type RouteDef,
} from "@sfly/schema";
import { queryOptions } from "@tanstack/react-query";
import { observeControlPlaneTime } from "./control-plane-time";
import { getNickname } from "./nickname";

export { ApiError };

const API_BASE = "/api";

/**
 * 控制面 HTTP API 客户端。浏览器请求同源的 `/api/*`：生产环境由控制面直接处理（去掉前缀后
 * 按原路由处理，见 apps/server/src/http/web-app.ts），开发时由 vite 原样代理到控制面（vite.config.ts）。
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
export const apiClient = createClient({
	baseUrl: API_BASE,
	nickname: getNickname,
	onControlPlaneTime: observeControlPlaneTime,
});

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

/** 浏览器访问的完整路径（带 `/api` 前缀与查询参数）：下载链接用。 */
export function apiUrl<D extends DownloadDef>(def: D, ...[input]: InputArgs<D>): string {
	return apiClient.url(def, input as RouteInput | undefined);
}

async function send<E extends EndpointDef>(
	def: E,
	input: EndpointInput<E> | undefined,
): Promise<EndpointResponse<E>> {
	const data = await apiClient.request(def, input as RouteInput | undefined);
	if (import.meta.env.DEV) {
		const parsed = def.response.safeParse(data);
		if (!parsed.success) {
			throw new ApiError({
				status: 200,
				code: "contract_violation",
				message: `响应不符合接口契约（${def.method} ${def.path}）`,
				details: parsed.error.issues,
				method: def.method,
				path: apiClient.url(def, input as RouteInput | undefined).slice(API_BASE.length),
			});
		}
	}
	return data as EndpointResponse<E>;
}

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
	return queryOptions({
		queryKey: ["download", def.path, { params, query }] as const,
		queryFn: async () => (await apiClient.request(def, input as RouteInput | undefined)).text(),
	});
}
