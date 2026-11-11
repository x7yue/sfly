import { NODE_SIZE, type Position, type StructureDocument, subflowName } from "@sfly/orchestration";
import type { AgentView, PackageSummary } from "@sfly/schema";
import type { DocNode } from "#/components/canvas/flow";
import { latestVersion } from "#/lib/package-versions";
import { devNodes } from "./catalog";
import { DEFAULT_TZ } from "./inspector/wait-nodes";

/** 添加节点菜单里的一项：内置节点，或某个节点包版本里的节点类型。 */
export type AddItem =
	| { kind: "async" | "timer" | "sleep" | "stop_subflow" }
	/** 子流程入口：新建时必须填写名称（SEMANTICS §1.2）。 */
	| { kind: "subflow_entry"; name: string }
	| { kind: "package"; package: string; version: string; node: string; title: string };

export const BUILTIN_ITEMS: { kind: Exclude<AddItem["kind"], "package">; hint: string }[] = [
	{ kind: "async", hint: "派发一个子流程" },
	{ kind: "timer", hint: "等到某个时刻" },
	{ kind: "sleep", hint: "等待一段时长" },
	{ kind: "stop_subflow", hint: "停止本链触发的子流程" },
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
	}
}

/**
 * 能不能在这个节点后面追加节点：已有链上出线时不行（链不能分叉），返回原因；可以时返回 null。
 * 链尾、游离节点都可以。
 */
export function appendProblem(doc: Pick<StructureDocument, "edges">, id: string): string | null {
	const taken = doc.edges.some((e) => e.kind === "chain" && e.from === id);
	return taken ? `节点 ${id} 已有出线，链不能分叉` : null;
}

/** 落点与已有节点重叠时每次往右下错开的距离。 */
const NUDGE = 32;

/**
 * 没有来源的新节点放在哪：想要的位置（视口中心、右键处）空着就用它，
 * 压住已有节点时按固定步长往右下错开，直到不压住任何节点。位置都是卡片左上角的画布坐标。
 */
export function freePosition(wanted: Position, taken: readonly Position[]): Position {
	const overlaps = (p: Position) =>
		taken.some(
			(t) => Math.abs(t.x - p.x) < NODE_SIZE.width && Math.abs(t.y - p.y) < NODE_SIZE.height,
		);
	let at = wanted;
	while (overlaps(at)) at = { x: at.x + NUDGE, y: at.y + NUDGE };
	return at;
}
