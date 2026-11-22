import {
	type AgentDevReport,
	devNodeTypes,
	formNodeTypes,
	type NodeTypeIo,
	nodeTypeOf,
	type PackageCatalog,
	packageKey,
	reportedNodeTypes,
} from "@sfly/orchestration";
import {
	type AgentView,
	DEV_VERSION,
	type FeishuBotView,
	packagesApi,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, apiQuery } from "#/lib/api";

/** 加载了某个包开发版本的 Agent（在线的排在前面）。 */
export const agentsWithDev = (agents: AgentView[], name: string) =>
	agents
		.filter((a) => a.dev_packages?.some((d) => d.name === name))
		.sort((a, b) => Number(b.status === "online") - Number(a.status === "online"));

/** Agent 列表 → 开发版本上报（给 `@sfly/orchestration` 里按派发目标取节点类型的纯函数用，控制面用的是同一个）。 */
export function devReports(agents: readonly AgentView[]): AgentDevReport[] {
	return agents.map((agent) => ({
		name: agent.name,
		online: agent.status === "online",
		devPackages: new Map((agent.dev_packages ?? []).map((d) => [d.name, d.metadata?.nodes])),
	}));
}

/**
 * 「添加节点」菜单用的开发版本节点类型：加载了这个包的 Agent 里第一台（在线的优先）上报的；没有 Agent 加载、上报的内容
 * 不合法时返回 undefined。菜单只是列出有哪些节点可以加，不做检查；检查和参数表单按节点派发到的 Agent 取
 * （{@link usePackageCatalog}、{@link inspectorNodeType}）。
 */
export function devNodes(agents: AgentView[], name: string): NodeTypeIo[] | undefined {
	const [agent] = agentsWithDev(agents, name);
	return reportedNodeTypes(agent?.dev_packages.find((d) => d.name === name)?.metadata?.nodes);
}

/**
 * 检查器里一个包节点的节点类型，两份：
 * - `checked`：检查用的，和控制面是同一套取法（`catalog` 里的：开发版本只按节点派发到的 Agent 取，查不到、对不齐时是
 *   undefined）；参数页的「没有声明 / 移除」按它：查不到时不报，不会让人删掉目标 Agent 其实声明了的输入；
 * - `form`：参数表单、执行设置、指标声明用的，尽力而为：检查用的有就用它，开发版本查不到时优先取这个节点派发到的
 *   Agent 上报的，再退到别的 Agent 的（{@link formNodeTypes}），表单不会因为检查跳过了就一直显示「加载中」。
 * null：找不到这个节点类型；undefined：还在加载（或没有 Agent 加载这个开发包）。
 */
export function inspectorNodeType(
	doc: StoredOrchestrationDocument,
	node: { package: string; node: string; agent?: string | undefined },
	catalog: PackageCatalog,
	agents: readonly AgentView[],
): { checked: NodeTypeIo | null | undefined; form: NodeTypeIo | null | undefined } {
	const checked = nodeTypeOf(doc, node, catalog);
	if (checked !== undefined || doc.packages[node.package] !== DEV_VERSION) {
		return { checked, form: checked };
	}
	const nodes = formNodeTypes(doc, node, devReports(agents));
	return { checked, form: nodes ? (nodes.find((n) => n.name === node.node) ?? null) : undefined };
}

/**
 * 场景锁定的节点包版本的元信息，用来生成参数表单、引用补全和静态检查（与控制面同一套规则）。
 * 还在加载的版本不在目录里，相关检查暂时跳过；开发版本（dev）按节点派发到的 Agent 上报的元信息取
 * （`@sfly/orchestration` 的 `devNodeTypes`，控制面用的是同一个函数：派发目标都在线、都加载了、内容相同才用），
 * 不确定时跳过，和控制面的检查结果一致。
 */
export function usePackageCatalog(
	doc: StoredOrchestrationDocument | undefined,
	agents: AgentView[],
): PackageCatalog {
	const locked = doc?.packages ?? NO_PACKAGES;
	const entries = Object.entries(locked).filter(([, version]) => version !== DEV_VERSION);
	const results = useQueries({
		queries: entries.map(([name, version]) => ({
			...apiQuery(packagesApi.version, { params: { name, version } }),
			staleTime: Number.POSITIVE_INFINITY, // 已发布的版本不可变
		})),
	});
	const dev = useMemo(() => (doc ? [...devNodeTypes(doc, devReports(agents))] : []), [doc, agents]);
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
			catalog.set(packageKey(name, DEV_VERSION), nodes);
		}
		return catalog;
	}, [key]);
}

const NO_PACKAGES: Record<string, string> = {};

/**
 * 已发布版本里某个节点类型的输入 schema：「添加节点」菜单的摘要里没有输入，选中节点时读。
 * 与 `usePackageCatalog` 是同一个查询（同一份缓存），场景接着就要锁定这个版本，不会多一次请求。
 */
export async function publishedNodeInputs(
	queryClient: QueryClient,
	item: { package: string; version: string; node: string },
): Promise<NodeTypeIo["inputs"] | undefined> {
	const found = await queryClient.ensureQueryData(
		apiQuery(packagesApi.version, { params: { name: item.package, version: item.version } }),
	);
	return found.metadata.nodes.find((n) => n.name === item.node)?.inputs;
}

/**
 * 已注册的 Agent 名称（「Agent」类型的输入的静态检查用）；Agent 列表还没加载时为 undefined（不检查）。
 * 列表每次轮询都是新对象：名称没变时返回同一个 Set，不让静态检查跟着重算。
 */
export function useRegisteredAgents(agents: AgentView[] | undefined): Set<string> | undefined {
	return useNameSet(agents?.map((a) => a.name));
}

/** 已登记的飞书机器人名称（「飞书机器人」类型的输入的静态检查用）；列表还没加载时为 undefined（不检查）。 */
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
