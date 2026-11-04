import { type NodeTypeIo, type PackageCatalog, packageKey } from "@sfly/orchestration";
import type { PackageMetadata } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, apiGet, type PackageSummary } from "#/lib/api";

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

/**
 * 编排锁定的节点包版本的元信息，用来生成参数表单、引用补全和静态检查（与控制面同一套规则）。
 * 还在加载的版本不在目录里，相关检查暂时跳过；开发版本（dev）控制面没有元信息。
 */
export function usePackageCatalog(locked: Record<string, string>): PackageCatalog {
	const entries = Object.entries(locked).filter(([, version]) => version !== "dev");
	const results = useQueries({
		queries: entries.map(([name, version]) => ({
			queryKey: ["package-version", name, version],
			queryFn: () => fetchVersionNodes(name, version),
			staleTime: Number.POSITIVE_INFINITY, // 已发布的版本不可变
		})),
	});
	// 只在锁定表或加载结果变化时生成新的目录，避免每次渲染都重新计算警告。
	const key = JSON.stringify(entries.map(([n, v], i) => [n, v, results[i]?.dataUpdatedAt]));
	// biome-ignore lint/correctness/useExhaustiveDependencies: key 覆盖了 entries 和 results 的变化
	return useMemo(() => {
		const catalog = new Map<string, readonly NodeTypeIo[] | null>();
		results.forEach((r, i) => {
			const [name, version] = entries[i] as [string, string];
			if (r.data !== undefined) catalog.set(packageKey(name, version), r.data);
		});
		return catalog;
	}, [key]);
}

/** 节点包的最新版本（按发布时间，与节点类型面板一致）。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) =>
	packages?.find((p) => p.name === name)?.versions[0]?.version;
