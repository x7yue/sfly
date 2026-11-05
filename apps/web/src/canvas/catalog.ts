import { type NodeTypeIo, type PackageCatalog, packageKey } from "@sfly/orchestration";
import { packagesApi } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AgentView, ApiError, agentsWithDev, callApi, type PackageSummary } from "#/lib/api";

/** `GET /packages/:name/versions/:version`；版本不存在时为 null。 */
async function fetchVersionNodes(name: string, version: string): Promise<NodeTypeIo[] | null> {
	try {
		const found = await callApi(packagesApi.version, { params: { name, version } });
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
			// 与 apiQuery(packagesApi.version) 的缓存分开：这里只取节点类型，版本不存在时为 null。
			queryKey: ["packages", "version-nodes", { params: { name, version } }],
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

/**
 * 比较两个版本号（PEP 440 的核心规则）：release 段逐段数值比较（缺的段当 0，1.0 与 1.0.0 相等）；
 * 字母段是预发布标记，排在同号正式版之前（1.0rc1 < 1.0）；都是字母时按字典序。
 * 返回值 < 0 表示 a 更旧。
 */
export function compareVersions(a: string, b: string): number {
	const ta = versionTokens(a);
	const tb = versionTokens(b);
	for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
		const x = ta[i];
		const y = tb[i];
		if (x === undefined && y === undefined) break;
		if (x === undefined) {
			if (typeof y === "string") return 1;
			if (y !== 0) return -1;
			continue;
		}
		if (y === undefined) {
			if (typeof x === "string") return -1;
			if (x !== 0) return 1;
			continue;
		}
		if (typeof x === "number" && typeof y === "number") {
			if (x !== y) return x - y;
			continue;
		}
		if (typeof x === "string" && typeof y === "string") {
			if (x !== y) return x < y ? -1 : 1;
			continue;
		}
		return typeof x === "string" ? -1 : 1;
	}
	return 0;
}

/** 把版本号切成数字/字母段：`1.0rc1` → [1, 0, "rc", 1]。 */
function versionTokens(version: string): Array<number | string> {
	const tokens: Array<number | string> = [];
	for (const m of version.toLowerCase().matchAll(/\d+|[a-z]+/g)) {
		tokens.push(/^\d/.test(m[0]) ? Number(m[0]) : m[0]);
	}
	return tokens;
}

/** 节点包的最新版本（按版本号比较，不是发布时间；故事 39）。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) => {
	const versions = packages?.find((p) => p.name === name)?.versions;
	if (!versions || versions.length === 0) return undefined;
	return versions.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b)).version;
};
