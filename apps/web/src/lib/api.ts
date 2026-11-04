import type { StructureWarning } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { getNickname, NICKNAME_HEADER } from "./nickname";

/**
 * 控制面 HTTP API 客户端。浏览器请求同源的 `/api/*`，由 vite（dev / preview）代理到控制面
 * （`SFLY_API_URL`，默认 http://127.0.0.1:8080，见 vite.config.ts）。
 * 每个请求都带上浏览器昵称请求头。
 */
export const API_BASE = "/api";

/** 控制面的错误响应 `{ error: { code, message, details? } }`。 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json" };
	const nickname = getNickname();
	if (nickname) headers[NICKNAME_HEADER] = encodeURIComponent(nickname);
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(`${API_BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
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
		);
	}
	return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => request<T>("GET", path);
export const apiPost = <T>(path: string, body: unknown) => request<T>("POST", path, body);

// —— 节点包 ——

export interface PackageVersionSummary {
	version: string;
	sha256: string;
	size: number;
	published_at: string;
	nodes: { name: string; title: string }[];
}

export interface PackageSummary {
	name: string;
	/** 按发布时间从新到旧。 */
	versions: PackageVersionSummary[];
}

export const listPackages = () => apiGet<{ packages: PackageSummary[] }>("/packages");

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
	warnings: StructureWarning[];
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
export const saveVersion = (id: string, document: OrchestrationDocument) =>
	apiPost<SavedVersion>(`/orchestrations/${id}/versions`, { document });

// —— Agent ——

export interface AgentView {
	name: string;
	status: "online" | "offline";
	info: { agent_version: string; os: string; arch: string; slots: number };
	last_seen_at: string;
	installed_packages: { name: string; version: string }[];
	running_tasks: {
		task_id: string;
		run_id: string;
		orchestration_id: string;
		node_id: string;
		attempt: number;
		started_at: string;
	}[];
}

export const listAgents = () => apiGet<{ agents: AgentView[] }>("/agents");
