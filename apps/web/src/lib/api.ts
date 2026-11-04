/**
 * 控制面 HTTP API 客户端。浏览器请求同源的 `/api/*`，由 vite（dev / preview）代理到控制面
 * （`SFLY_API_URL`，默认 http://127.0.0.1:8080，见 vite.config.ts）。
 */
export const API_BASE = "/api";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export async function apiGet<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

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
