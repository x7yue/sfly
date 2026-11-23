import {
	type AgentDevReport,
	devNodeTypes,
	dispatchAgentOf,
	formNodeTypes,
	type NodeTypeIo,
	type NodeTypeLookup,
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

/** 画布上按节点取节点类型要的节点字段。 */
type TypedNode = { package: string; node: string; agent?: string | undefined };

/**
 * 一个包节点参数表单用的节点类型（尽力而为）：检查用的（`catalog` 里的）有就用它；开发版本检查跳过时，取这个节点派发到的
 * Agent 上报的，再退到别的 Agent 的（{@link formNodeTypes}）。**每个节点按自己的派发目标取**：同一个包、同一个节点类型的
 * 几个节点派发到不同的 Agent 时，各自用各自的声明，不合并。
 * `from`：表单的声明取自哪台 Agent，只在取自别的 Agent（不是节点派发到的那台）时有值。
 */
function formTypeOf(
	doc: StoredOrchestrationDocument,
	node: TypedNode,
	catalog: PackageCatalog,
	reports: readonly AgentDevReport[],
): {
	checked: NodeTypeIo | null | undefined;
	form: NodeTypeIo | null | undefined;
	from: string | undefined;
} {
	const checked = nodeTypeOf(doc, node, catalog);
	if (checked !== undefined || doc.packages[node.package] !== DEV_VERSION) {
		return { checked, form: checked, from: undefined };
	}
	const reported = formNodeTypes(doc, node, reports);
	if (!reported) return { checked, form: undefined, from: undefined };
	const form = reported.nodes.find((n) => n.name === node.node) ?? null;
	const from = form && reported.agent !== dispatchAgentOf(doc, node) ? reported.agent : undefined;
	return { checked, form, from };
}

/**
 * 检查器里一个包节点的节点类型，两份：
 * - `checked`：检查用的，和控制面是同一套取法（`catalog` 里的：开发版本只按节点派发到的 Agent 取，查不到、对不齐时是
 *   undefined）；参数页的「没有声明 / 移除」按它：查不到时不报，不会让人删掉目标 Agent 其实声明了的输入；
 * - `form`：参数表单、执行设置、指标声明用的，尽力而为：检查用的有就用它，开发版本查不到时优先取这个节点派发到的
 *   Agent 上报的，再退到别的 Agent 的（{@link formNodeTypes}），表单不会因为检查跳过了就一直显示「加载中」。
 * null：找不到这个节点类型；undefined：还在加载（或没有 Agent 加载这个开发包）。
 * `from`：`form` 取自别的 Agent（不是节点派发到的那台）时是那台的名字，界面据此说明字段取自哪台（{@link formSourceNote}）。
 */
export function inspectorNodeType(
	doc: StoredOrchestrationDocument,
	node: TypedNode,
	catalog: PackageCatalog,
	agents: readonly AgentView[],
): {
	checked: NodeTypeIo | null | undefined;
	form: NodeTypeIo | null | undefined;
	from: string | undefined;
} {
	return formTypeOf(doc, node, catalog, devReports(agents));
}

/**
 * 参数表单的声明取自别的 Agent 时，参数页上的一句中性的说明：字段是哪台上报的，节点派发到的那台为什么没有检查。
 * 取自节点派发到的 Agent（或检查用的）时没有，返回 undefined。
 */
export function formSourceNote(
	doc: Pick<StoredOrchestrationDocument, "default_agent">,
	node: { agent?: string | undefined },
	from: string | undefined,
): string | undefined {
	if (from === undefined) return undefined;
	const target = dispatchAgentOf(doc, node);
	return target === undefined
		? `表单按 ${from} 上报的声明生成；这个节点没有确定的 Agent，没有检查。`
		: `表单按 ${from} 上报的声明生成；节点派发到的 ${target} 的声明查不到，没有检查。`;
}

/**
 * 检查跳过时（开发版本节点派发到的 Agent 的声明查不到：离线、没加载、几台内容不同），节点上已经填了、而参数表单那份节点类型里
 * 没有的输入：这些输入在参数页上没有字段，也不在「没有声明」里（检查没做），要列成中性的一行（说明声明查不到、没有检查）、
 * 可以移除，不然它们完全看不到、也删不掉。已发布的版本、检查做了的开发版本没有这回事，返回空。
 * `form` 是 null（找不到这个节点类型）或 undefined（没有 Agent 加载它）时，节点上填的每个输入都算。
 * Agent 列表还没拿到时（`form` 同样是 undefined，但不是「没有 Agent 加载」）调用方不要调它：这时什么都不知道，不该说「没有检查」。
 */
export function uncheckedInputs(
	doc: Pick<StoredOrchestrationDocument, "packages">,
	node: { package: string; inputs: Record<string, unknown> },
	types: { checked: NodeTypeIo | null | undefined; form: NodeTypeIo | null | undefined },
): string[] {
	if (doc.packages[node.package] !== DEV_VERSION || types.checked !== undefined) return [];
	const shown = types.form?.inputs.properties ?? {};
	return Object.keys(node.inputs).filter((name) => !Object.hasOwn(shown, name));
}

/**
 * 引用补全和「复制输出引用」按节点取节点类型：每个上游节点用**它自己**的表单那份声明（检查用的目录里有就用目录的；开发版本检查
 * 跳过时，取节点派发到的 Agent 上报的、找不到再取别的 Agent 的），和参数页同一个取法（{@link inspectorNodeType} 的 `form`）。
 * 不并成一份以包为键的目录：同一个包、同一个节点类型的几个节点派发到不同的 Agent 时，声明可能不同，各列各的输出，
 * 和 `nodes` 数组里谁排在前面无关。补全不拦东西，只是列出可以引用的输出；检查用的目录不受影响（警告和控制面一致）。
 */
export function completionTypes(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
	agents: readonly AgentView[],
): NodeTypeLookup {
	const reports = devReports(agents);
	return (node) => formTypeOf(doc, node, catalog, reports).form;
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
