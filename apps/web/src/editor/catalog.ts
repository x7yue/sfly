import { type NodeTypeIo, type PackageCatalog, packageKey } from "@sfly/orchestration";
import { type AgentView, type FeishuBotView, packagesApi } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, apiQuery } from "#/lib/api";

/** 加载了某个包开发版本的 Agent（在线的排在前面）。 */
export const agentsWithDev = (agents: AgentView[], name: string) =>
	agents
		.filter((a) => a.dev_packages?.some((d) => d.name === name))
		.sort((a, b) => Number(b.status === "online") - Number(a.status === "online"));

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
 * 场景锁定的节点包版本的元信息，用来生成参数表单、引用补全和静态检查（与控制面同一套规则）。
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
			...apiQuery(packagesApi.version, { params: { name, version } }),
			staleTime: Number.POSITIVE_INFINITY, // 已发布的版本不可变
		})),
	});
	const dev = Object.entries(locked)
		.filter(([, version]) => version === "dev")
		.map(([name]) => [name, devNodes(agents, name)] as const);
	// 只在锁定表或加载结果变化时生成新的目录，避免每次渲染都重新计算警告。
	const key = JSON.stringify([
		entries.map(([n, v], i) => [n, v, results[i]?.dataUpdatedAt, results[i]?.errorUpdatedAt]),
		dev,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key 覆盖了 entries 和 results 的变化
	return useMemo(() => {
		const catalog = new Map<string, readonly NodeTypeIo[] | null>();
		results.forEach((r, i) => {
			const [name, version] = entries[i] as [string, string];
			// 版本不存在（404，不重试）时目录里记为 null，引用检查据此报出「锁定的版本不存在」。
			if (r.data) catalog.set(packageKey(name, version), r.data.metadata.nodes);
			else if (r.error instanceof ApiError && r.error.status === 404) {
				catalog.set(packageKey(name, version), null);
			}
		});
		for (const [name, nodes] of dev) {
			if (nodes) catalog.set(packageKey(name, "dev"), nodes);
		}
		return catalog;
	}, [key]);
}

/**
 * 已注册的 Agent 名称（「Agent」类型的输入的静态检查用）；Agent 列表还没加载时为 undefined（不检查）。
 * 列表每次轮询都是新对象：名称没变时返回同一个 Set，不让静态检查跟着重算。
 */
export function useRegisteredAgents(agents: AgentView[] | undefined): Set<string> | undefined {
	return useNameSet(agents?.map((a) => a.name));
}

/** 已登记的飞书机器人名称（飞书通知节点的静态检查用）；列表还没加载时为 undefined（只检查有没有选择）。 */
export function useRegisteredBots(bots: FeishuBotView[] | undefined): Set<string> | undefined {
	return useNameSet(bots?.map((b) => b.name));
}

/** 名称列表 → Set；名称没变时返回同一个 Set。 */
function useNameSet(list: string[] | undefined): Set<string> | undefined {
	const names = list?.join("\n");
	return useMemo(
		() => (names === undefined ? undefined : new Set(names === "" ? [] : names.split("\n"))),
		[names],
	);
}
