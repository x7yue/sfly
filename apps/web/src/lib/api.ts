import type { OrchestrationWarning } from "@sfly/orchestration";
import {
	type AgentView,
	agentsApi,
	type EndpointDef,
	type EndpointInput,
	type EndpointResponse,
	type OrchestrationDocument,
	packagesApi,
	pathFor,
	queryKey,
} from "@sfly/schema";
import { queryOptions } from "@tanstack/react-query";
import { getNickname, NICKNAME_HEADER } from "./nickname";

/**
 * 控制面 HTTP API 客户端。浏览器请求同源的 `/api/*`：生产环境由控制面直接处理（去掉前缀后
 * 按原路由处理，见 apps/server/src/http/web-app.ts），开发时由 vite 原样代理到控制面（vite.config.ts）。
 * 每个请求都带上浏览器昵称请求头。
 *
 * 新代码一律走契约（@sfly/schema 的 http 模块，ADR 0007）：
 *
 *   const agents = useQuery(apiQuery(agentsApi.list));                       // 查询
 *   await callApi(packagesApi.version, { params: { name, version } });     // 直接调用
 *   queryClient.invalidateQueries({ queryKey: ["packages"] });              // 按领域失效
 *
 * 类型由契约推导，开发环境（vite dev）下响应会按契约解析，不符合时抛出 code 为
 * `contract_violation` 的 ApiError（页面上显示为错误状态，details 是 zod issues）。
 * 下面 `apiGet` / `apiPost` 与手写类型是 MVP 遗留，迁到契约后删除（#44）。
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
	let res: Response;
	const headers: Record<string, string> = { accept: "application/json" };
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
	return (await res.json()) as T;
}

/** 按契约调用接口（约定见 packages/schema/src/http/contract.ts）。 */
export function callApi<E extends EndpointDef>(
	def: E,
	...[input]: InputArgs<E>
): Promise<EndpointResponse<E>> {
	return send(def, input);
}

/** 没有 params / query / body 的接口不需要传第二个参数。 */
type InputArgs<E extends EndpointDef> = keyof EndpointInput<E> extends never
	? []
	: [EndpointInput<E>];

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

export const apiGet = <T>(path: string) => request<T>("GET", path);
export const apiPost = <T>(path: string, body: unknown) => request<T>("POST", path, body);

// —— 节点包（契约：packagesApi） ——

export type { PackageSummary, PackageVersionSummary } from "@sfly/schema";

export const listPackages = () => callApi(packagesApi.list);

// —— 编排 ——

export interface Orchestration {
	id: string;
	name: string;
	head_version: number;
	created_at: string;
}

export interface OrchestrationHead {
	orchestration_id: string;
	/** 0 表示还没有保存过版本（document 是只含入口节点的初始文档）。 */
	number: number;
	author: string | null;
	created_at: string | null;
	document: OrchestrationDocument;
}

export interface SavedVersion {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	created_at: string;
	document: OrchestrationDocument;
	warnings: OrchestrationWarning[];
}

export const listOrchestrations = () =>
	apiGet<{ orchestrations: Orchestration[] }>("/orchestrations");
export const getOrchestration = (id: string) => apiGet<Orchestration>(`/orchestrations/${id}`);
export const getOrchestrationHead = (id: string) =>
	apiGet<OrchestrationHead>(`/orchestrations/${id}/head`);
export const createOrchestration = (name: string) =>
	apiPost<Orchestration>("/orchestrations", { name });
export const copyOrchestration = (id: string, name: string) =>
	apiPost<Orchestration>(`/orchestrations/${id}/copy`, { name });
// 保存版本、版本历史与恢复见 src/versions/api.ts（保存必须带 base_version，#16）。

// —— Agent（契约：agentsApi） ——

export type { AgentView, DevPackageView } from "@sfly/schema";

/** 加载了某个包开发版本的 Agent（在线的排在前面）。 */
export const agentsWithDev = (agents: AgentView[], name: string) =>
	agents
		.filter((a) => a.dev_packages?.some((d) => d.name === name))
		.sort((a, b) => Number(b.status === "online") - Number(a.status === "online"));

export const listAgents = () => callApi(agentsApi.list);
