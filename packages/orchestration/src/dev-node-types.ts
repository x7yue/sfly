import { DEV_VERSION, IoSchema, type StoredOrchestrationDocument } from "@sfly/schema";
import type { NodeTypeIo } from "./references.js";

/**
 * 开发版本（`包名@dev`，docs/SEMANTICS.md §7）的节点类型：节点派发到的 Agent 以 `sfly dev` 加载源码时上报的元信息。
 * 控制面（保存时的检查、触发前的预检）和画布（检查器里的警告、参数页的「没有声明」）都按这里的规则取，
 * 同一份文档在两边得到同样的检查结果。纯函数：输入是文档和每台 Agent 的名字、是否在线、上报的内容，不读库、不请求。
 *
 * 取法（元信息没有经过发布校验，也可能过期，所以只在确定的时候用，不确定就当作不知道，相关检查跳过，照常触发，
 * 交给运行时）：
 * - **只看用到这个包的节点实际派发到的 Agent**（{@link dispatchAgentOf}）：别的 Agent 上加载的是旧源码还是新源码，
 *   和这个节点跑在哪里无关；
 * - 这几台必须都在线（不在线的 Agent，控制面记着的是它上次连接时上报的，现在加载了什么不知道）、都加载了这个包、
 *   上报的节点类型内容相同；有一台不满足（不在列表里、不在线、没有加载、内容不同、上报的内容不是合法的节点类型）
 *   就不检查这个包——整包跳过，不按节点：目录按包一份。
 */

/** 包节点里派发用得到的字段（`agent` 可以不写）。 */
type DispatchNode = { agent?: string | undefined };

/** 一台 Agent 的开发版本上报：名字、是否在线、它加载的开发包（包名 → 上报的 `metadata.nodes`，没有校验过的原样内容）。 */
export interface AgentDevReport {
	name: string;
	online: boolean;
	devPackages: ReadonlyMap<string, unknown>;
}

/**
 * 包节点派发到的 Agent：节点另选的 Agent 优先，否则用编排的默认 Agent；都没有时为 undefined。
 * **引擎派发（`agentFor`）、触发前的 `dev_package_not_loaded`、开发版本的节点类型都用它**，派发到哪台只在这里定义一次。
 */
export function dispatchAgentOf(
	doc: Pick<StoredOrchestrationDocument, "default_agent">,
	node: DispatchNode,
): string | undefined {
	return node.agent ?? doc.default_agent;
}

/** 上报的 `metadata.nodes` 是不是合法的节点类型列表（名字、输入和输出的 JSON Schema）；是就原样返回。 */
export function reportedNodeTypes(raw: unknown): NodeTypeIo[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	for (const node of raw as unknown[]) {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
		const { name, inputs, outputs, description } = node as Record<string, unknown>;
		if (typeof name !== "string") return undefined;
		if (!IoSchema.safeParse(inputs).success || !IoSchema.safeParse(outputs).success)
			return undefined;
		if (description !== undefined && typeof description !== "string") return undefined;
	}
	return raw as NodeTypeIo[];
}

/** 两份 JSON 内容是否相同（对象不看键的顺序，数组看顺序）。 */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
	);
}

/**
 * 锁定开发版本的包 → 用到它的包节点派发到的 Agent 名字；有一个节点没有确定的 Agent（没写、又没有默认 Agent）时是 null
 * （这个包不检查）。没有锁定开发版本的包不在里面。
 */
export function devPackageTargets(
	doc: StoredOrchestrationDocument,
): Map<string, ReadonlySet<string> | null> {
	const targets = new Map<string, Set<string> | null>();
	for (const node of doc.nodes) {
		if (node.kind !== "package" || doc.packages[node.package] !== DEV_VERSION) continue;
		const agent = dispatchAgentOf(doc, node);
		const known = targets.get(node.package);
		if (known === null) continue;
		if (!agent) targets.set(node.package, null);
		else if (known === undefined) targets.set(node.package, new Set([agent]));
		else known.add(agent);
	}
	return targets;
}

/** 检查用的开发版本节点类型：包名 → 节点类型；不确定的包不在里面（见文件开头的取法）。 */
export function devNodeTypes(
	doc: StoredOrchestrationDocument,
	agents: readonly AgentDevReport[],
): Map<string, readonly NodeTypeIo[]> {
	const known = new Map<string, readonly NodeTypeIo[]>();
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	for (const [pkg, targets] of devPackageTargets(doc)) {
		if (targets === null) continue;
		const reported = [...targets].map((name) => {
			const agent = byName.get(name);
			if (!agent?.online || !agent.devPackages.has(pkg)) return undefined;
			return reportedNodeTypes(agent.devPackages.get(pkg));
		});
		const [first] = reported;
		if (first === undefined || !reported.every((nodes) => nodes && sameJson(nodes, first)))
			continue;
		known.set(pkg, first);
	}
	return known;
}

/**
 * 参数表单用的开发版本节点类型（尽力而为，不是检查用的）：检查跳过时表单也得有字段可以填，不能一直显示「加载中」。
 * 优先取这个节点自己派发到的 Agent 上报的（在线与否都用），其次是在线的 Agent 里第一台加载了这个包的，再其次是
 * 加载过的第一台；都没有时是 undefined（没有 Agent 加载它，表单没有字段可生成）。
 */
export function formNodeTypes(
	doc: Pick<StoredOrchestrationDocument, "default_agent">,
	node: DispatchNode & { package: string },
	agents: readonly AgentDevReport[],
): readonly NodeTypeIo[] | undefined {
	const target = dispatchAgentOf(doc, node);
	const loaders = agents.filter((agent) => agent.devPackages.has(node.package));
	const ordered = [
		...loaders.filter((agent) => agent.name === target),
		...loaders.filter((agent) => agent.name !== target && agent.online),
		...loaders.filter((agent) => agent.name !== target && !agent.online),
	];
	for (const agent of ordered) {
		const nodes = reportedNodeTypes(agent.devPackages.get(node.package));
		if (nodes) return nodes;
	}
	return undefined;
}

/**
 * 开发版本的警告末尾的一句提醒：节点类型取自节点派发到的 Agent 上次运行 `sfly dev` 时上报的元信息，刚改过节点的
 * `changed`（「参数」或「输出」）而没有重新运行时是旧的，检查会拦住运行时其实能接受的内容。写明是哪台 Agent。
 * 已发布的版本（元信息不会变）没有这一句，返回空串。
 */
export function devRefreshHint(
	doc: Pick<StoredOrchestrationDocument, "packages" | "default_agent">,
	node: DispatchNode & { package: string },
	changed: "参数" | "输出",
): string {
	if (doc.packages[node.package] !== DEV_VERSION) return "";
	const agent = dispatchAgentOf(doc, node);
	return agent === undefined
		? `（开发版本的声明是 Agent 上次运行 sfly dev 时上报的，刚改过节点的${changed}的话，在那台机器上重新运行 sfly dev）`
		: `（开发版本的声明取自节点派发到的 Agent ${agent} 上次运行 sfly dev 时的上报，刚改过节点的${changed}的话，在 ${agent} 所在的机器上重新运行 sfly dev）`;
}
