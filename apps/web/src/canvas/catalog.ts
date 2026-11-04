import { type NodeTypeIo, type PackageCatalog, packageKey } from "@sfly/orchestration";
import type { PackageMetadata } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AgentView, ApiError, agentsWithDev, apiGet, type PackageSummary } from "#/lib/api";

/** `GET /packages/:name/versions/:version`；版本不存在时为 null。 */
async function fetchVersionNodes(name: string, version: string): Promise<NodeTypeIo[] | null> {
	try {
		const found = await apiGet<{ metadata: PackageMetadata }>(
			`/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
		);
		return found.metadata.nodes;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null;
		throw error;
	}
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 开发版本（dev）的节点类型：取加载了它的 Agent 上报的元信息（在线的 Agent 优先）。
 * 没有 Agent 加载时返回 undefined（不知道，相关检查跳过）。
 */
export function devNodes(agents: AgentView[], name: string): NodeTypeIo[] | undefined {
	const [agent] = agentsWithDev(agents, name);
	const nodes = agent?.dev_packages.find((d) => d.name === name)?.metadata?.nodes;
	if (!Array.isArray(nodes)) return undefined;
	const valid = nodes.every(
		(n) => isObject(n) && typeof n.name === "string" && isObject(n.inputs) && isObject(n.outputs),
	);
	return valid ? (nodes as NodeTypeIo[]) : undefined;
}

/**
 * 编排锁定的节点包版本的元信息，用来生成参数表单、引用补全和静态检查（与控制面同一套规则）。
 * 还在加载的版本不在目录里，相关检查暂时跳过；开发版本（dev）用 Agent 上报的元信息，
 * 没有 Agent 加载它时同样跳过。
 */
export function usePackageCatalog(
	locked: Record<string, string>,
	agents: AgentView[],
): PackageCatalog {
	const entries = Object.entries(locked).filter(([, version]) => version !== "dev");
	const results = useQueries({
		queries: entries.map(([name, version]) => ({
			queryKey: ["package-version", name, version],
			queryFn: () => fetchVersionNodes(name, version),
			staleTime: Number.POSITIVE_INFINITY, // 已发布的版本不可变
		})),
	});
	const dev = Object.entries(locked)
		.filter(([, version]) => version === "dev")
		.map(([name]) => [name, devNodes(agents, name)] as const);
	// 只在锁定表或加载结果变化时生成新的目录，避免每次渲染都重新计算警告。
	const key = JSON.stringify([entries.map(([n, v], i) => [n, v, results[i]?.dataUpdatedAt]), dev]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key 覆盖了 entries 和 results 的变化
	return useMemo(() => {
		const catalog = new Map<string, readonly NodeTypeIo[] | null>();
		results.forEach((r, i) => {
			const [name, version] = entries[i] as [string, string];
			if (r.data !== undefined) catalog.set(packageKey(name, version), r.data);
		});
		for (const [name, nodes] of dev) {
			if (nodes) catalog.set(packageKey(name, "dev"), nodes);
		}
		return catalog;
	}, [key]);
}

/** 节点包的最新版本（按发布时间，与节点类型面板一致）。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) =>
	packages?.find((p) => p.name === name)?.versions[0]?.version;
