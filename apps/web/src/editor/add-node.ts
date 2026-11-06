import { chainMembers, type StructureDocument } from "@sfly/orchestration";
import type { AgentView, PackageSummary } from "@sfly/schema";
import type { DocNode } from "#/components/canvas/flow";
import { latestVersion } from "#/lib/package-versions";
import { devNodes } from "./catalog";
import { DEFAULT_TZ } from "./inspector/wait-nodes";

/** 添加节点菜单里的一项：内置节点，或某个节点包版本里的节点类型。 */
export type AddItem =
	| { kind: "async" | "timer" | "sleep" | "subflow_entry" }
	| { kind: "package"; package: string; version: string; node: string; title: string };

export const BUILTIN_ITEMS: { kind: Exclude<AddItem["kind"], "package">; hint: string }[] = [
	{ kind: "async", hint: "派发一个子流程" },
	{ kind: "timer", hint: "等到某个时刻" },
	{ kind: "sleep", hint: "等待一段时长" },
	{ kind: "subflow_entry", hint: "新建子流程区域" },
];

/** 菜单里按节点包分组的节点类型。 */
export interface PackageGroup {
	name: string;
	version: string;
	items: Extract<AddItem, { kind: "package" }>[];
}

/**
 * 可以添加的包节点：已锁定的包用锁定的版本（dev 用 Agent 上报的元信息），其他包用最新版本（按版本号）；
 * 另外列出只有 dev 版本（从未发布、某个 Agent 以开发模式加载）的包。
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
	return groups;
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
			return { id, kind: "subflow_entry", params: [] };
		case "timer":
			return { id, kind: "timer", always: false, at: "09:30:00", tz: DEFAULT_TZ };
		case "sleep":
			return { id, kind: "sleep", always: false, duration: "30s" };
	}
}

/** 节点所在链（主链或子流程）的链尾；节点不在任何链上时为 undefined。 */
function tailOfChainWith(doc: StructureDocument, id: string): string | undefined {
	for (const members of chainMembers(doc).values()) {
		if (members.includes(id)) return members.at(-1);
	}
	return undefined;
}

/**
 * 从菜单添加的节点接在哪个链尾之后：选中了某条链（主链或子流程）上的节点时接在那条链的链尾，
 * 否则接在主链的链尾。没有入口节点时为 undefined。
 */
export function appendTarget(
	doc: StructureDocument,
	selectedId: string | null,
): string | undefined {
	const fromSelected = selectedId ? tailOfChainWith(doc, selectedId) : undefined;
	if (fromSelected) return fromSelected;
	const entry = doc.nodes.find((n) => n.kind === "entry");
	return entry ? tailOfChainWith(doc, entry.id) : undefined;
}

/** 节点是不是主链或子流程的链尾（只有链尾可以往后追加节点）。 */
export const isChainTail = (doc: StructureDocument, id: string) => tailOfChainWith(doc, id) === id;
