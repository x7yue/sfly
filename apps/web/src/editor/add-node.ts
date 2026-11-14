import { type StructureDocument, subflowName } from "@sfly/orchestration";
import type { AgentView, PackageSummary } from "@sfly/schema";
import type { DocNode } from "#/components/canvas/flow";
import { latestVersion } from "#/lib/package-versions";
import { devNodes } from "./catalog";
import { DEFAULT_TZ } from "./inspector/wait-nodes";

/** 添加节点菜单里的一项：内置节点，或某个节点包版本里的节点类型。 */
export type AddItem =
	| { kind: "timer" | "sleep" | "stop_subflow" | "feishu_notify" }
	/** 异步任务：勾选「同时新建子流程」时带上子流程名称，一并新建子流程入口和调度连线（#187）。 */
	| { kind: "async"; subflow?: string }
	/** 子流程入口：新建时必须填写名称（SEMANTICS §1.2）。 */
	| { kind: "subflow_entry"; name: string }
	| { kind: "package"; package: string; version: string; node: string; title: string };

export type BuiltinKind = Exclude<AddItem["kind"], "package">;
export type PackageItem = Extract<AddItem, { kind: "package" }>;

export const BUILTIN_ITEMS: { kind: BuiltinKind; hint: string }[] = [
	{ kind: "async", hint: "派发一个子流程" },
	{ kind: "timer", hint: "等到某个时刻" },
	{ kind: "sleep", hint: "等待一段时长" },
	{ kind: "stop_subflow", hint: "停止本链触发的子流程" },
	{ kind: "feishu_notify", hint: "向飞书群发一条消息" },
	{ kind: "subflow_entry", hint: "新建子流程区域" },
];

export type BuiltinItem = (typeof BUILTIN_ITEMS)[number];

/** 子流程入口只能由调度连线触发，不能接在链上：有来源节点时不列。 */
export const availableBuiltins = (hasSource: boolean): BuiltinItem[] =>
	BUILTIN_ITEMS.filter((b) => !hasSource || b.kind !== "subflow_entry");

/** 菜单里按节点包分组的节点类型。 */
export interface PackageGroup {
	name: string;
	version: string;
	items: PackageItem[];
}

/** 菜单项的 cmdk value，同时是「最近使用」里存的身份（只记身份，不记版本）。 */
export const builtinValue = (kind: BuiltinKind) => `builtin:${kind}`;
export const packageValue = (item: Pick<PackageItem, "package" | "node">) =>
	`package:${item.package}/${item.node}`;
export const itemValue = (item: AddItem) =>
	item.kind === "package" ? packageValue(item) : builtinValue(item.kind);

export const MAX_RECENT = 5;

export const pushRecent = (recent: readonly string[], value: string): string[] =>
	[value, ...recent.filter((v) => v !== value)].slice(0, MAX_RECENT);

/**
 * 「最近使用」在菜单里的项：存的身份到当前可以添加的内置节点与包节点里解析，已经不存在的
 * （包下架、版本里没有这个节点、有来源节点时的子流程入口）丢掉。
 */
export function recentItems(
	recent: readonly string[],
	builtins: readonly BuiltinItem[],
	groups: readonly PackageGroup[],
): { value: string; entry: BuiltinItem | PackageItem }[] {
	const known = new Map<string, BuiltinItem | PackageItem>([
		...builtins.map((b) => [builtinValue(b.kind), b] as const),
		...groups.flatMap((g) => g.items.map((item) => [packageValue(item), item] as const)),
	]);
	return recent.flatMap((value) => {
		const entry = known.get(value);
		return entry ? [{ value, entry }] : [];
	});
}

/**
 * 可以添加的包节点：已锁定的包用锁定的版本（dev 用 Agent 上报的元信息），其他包用最新版本（按版本号）；
 * 另外列出只有 dev 版本（从未发布、某个 Agent 以开发模式加载）的包。本场景已锁定的包排在前面，其余保持原顺序。
 */
export function packageGroups(
	packages: PackageSummary[] | undefined,
	agents: AgentView[],
	locked: Readonly<Record<string, string>>,
): PackageGroup[] {
	const groups: PackageGroup[] = [];
	const group = (name: string, version: string, nodes: { name: string; title?: string }[]) => {
		if (nodes.length === 0) return;
		groups.push({
			name,
			version,
			items: nodes.map((n) => ({
				kind: "package",
				package: name,
				version,
				node: n.name,
				title: n.title ?? n.name,
			})),
		});
	};
	const published = new Set<string>();
	for (const pkg of packages ?? []) {
		published.add(pkg.name);
		const version = locked[pkg.name] ?? latestVersion(packages, pkg.name);
		if (version === "dev") group(pkg.name, "dev", devNodes(agents, pkg.name) ?? []);
		else {
			const found = pkg.versions.find((v) => v.version === version);
			if (found) group(pkg.name, found.version, found.nodes);
		}
	}
	const devOnly = new Set(agents.flatMap((a) => a.dev_packages?.map((d) => d.name) ?? []));
	for (const name of [...devOnly].filter((n) => !published.has(n)).sort()) {
		group(name, "dev", devNodes(agents, name) ?? []);
	}
	const isLocked = (g: PackageGroup) => Object.hasOwn(locked, g.name);
	return groups.sort((a, b) => Number(isLocked(b)) - Number(isLocked(a)));
}

/**
 * 新建子流程入口时填写的名称有什么问题：为空，或与已有子流程重名（按 subflowName 比较，
 * 没有名称字段的旧子流程以节点 ID 作为名称）。可以使用时返回 null。
 */
export function newSubflowNameProblem(
	name: string,
	doc: Pick<StructureDocument, "nodes">,
): string | null {
	const wanted = name.trim();
	if (wanted === "") return "请填写子流程名称";
	const taken = doc.nodes.find((n) => n.kind === "subflow_entry" && subflowName(n) === wanted);
	return taken ? `子流程入口节点 ${taken.id} 已使用名称「${wanted}」` : null;
}

/** 新节点 ID 的前缀。 */
export const idStem = (item: AddItem) =>
	item.kind === "package" ? item.node : item.kind === "subflow_entry" ? "subflow" : item.kind;

/** 新节点的初始内容。 */
export function newDocNode(item: AddItem, id: string): DocNode {
	switch (item.kind) {
		case "package":
			return {
				id,
				kind: "package",
				package: item.package,
				node: item.node,
				always: false,
				inputs: {},
			};
		case "async":
			return { id, kind: "async", params: {} };
		case "subflow_entry":
			return { id, kind: "subflow_entry", name: item.name.trim(), params: [] };
		case "timer":
			return { id, kind: "timer", always: false, at: "09:30:00", tz: DEFAULT_TZ };
		case "sleep":
			return { id, kind: "sleep", always: false, duration: "30s" };
		case "stop_subflow":
			// 要停止的子流程在检查器里按名称选择（只列出合法候选）。
			return { id, kind: "stop_subflow", always: false };
		case "feishu_notify":
			// 飞书机器人在检查器里选择。
			return {
				id,
				kind: "feishu_notify",
				always: false,
				format: "text",
				text: "",
				at_all: false,
				title: "",
				color: "blue",
				markdown: "",
			};
	}
}
