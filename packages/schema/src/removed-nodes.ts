/**
 * 已移除的节点种类（ADR 0028）：平台不再支持，但历史版本和历史运行里还留着它们，只读显示：
 * 不执行、不能保存、触发被预检阻断，在画布上删掉之后才能保存。
 *
 * 移除一种节点：在场景文档 schema（orchestration-document.ts）里删掉它的定义，在这里登记它的名称和替换办法
 * （`outputs` 是原来的输出名，没有输出的写空数组：别的节点引用过它们的，要一起改）；
 * 读取、运行记录、预检、画布提示都从这一处取，不各写一份。
 */
export const REMOVED_NODE_KINDS = {
	feishu_notify: {
		label: "飞书通知",
		replacement: "在节点代码里用 ctx.notify 发飞书消息",
		outputs: [],
	},
	timer: {
		label: "定时",
		replacement: "在节点代码里等到那个时刻，或把场景拆成两次运行",
		outputs: ["triggered_at", "late"],
	},
	sleep: {
		label: "Sleep",
		replacement: "在节点代码里等待，或把场景拆成两次运行",
		outputs: ["triggered_at"],
	},
} as const satisfies Record<
	string,
	{ label: string; replacement: string; outputs: readonly string[] }
>;

export type RemovedNodeKind = keyof typeof REMOVED_NODE_KINDS;

/** 已移除的种类名（zod 枚举要求至少一项）。 */
export const REMOVED_NODE_KIND_NAMES = Object.keys(REMOVED_NODE_KINDS) as [
	RemovedNodeKind,
	...RemovedNodeKind[],
];

/** 已移除的种类原来的输出名；没有输出的是空数组。 */
export const removedKindOutputs = (kind: RemovedNodeKind): readonly string[] =>
	REMOVED_NODE_KINDS[kind].outputs;

export const isRemovedNodeKind = (kind: string): kind is RemovedNodeKind =>
	Object.hasOwn(REMOVED_NODE_KINDS, kind);

/** 已移除节点在历史记录里的名称：「已移除的节点类型」加它当时的种类名，例如 `已移除的节点类型 feishu_notify`。 */
export const removedKindLabel = (kind: string): string => `已移除的节点类型 ${kind}`;

/** 一个已移除的节点：节点 ID，种类，和该种类的替换办法。 */
export interface RemovedNodeNotice {
	id: string;
	kind: RemovedNodeKind;
	replacement: string;
}

/** 文档（或任何带节点列表的东西）里的已移除节点，按它们在文档里的顺序。 */
export function removedNodesIn(doc: {
	nodes: readonly { id: string; kind: string }[];
}): RemovedNodeNotice[] {
	return doc.nodes.flatMap(({ id, kind }) =>
		isRemovedNodeKind(kind)
			? [{ id, kind, replacement: REMOVED_NODE_KINDS[kind].replacement }]
			: [],
	);
}

/**
 * 保存时遇到已移除的节点的说明：哪些节点、种类名、怎么替换。控制面拒绝保存的错误信息和画布保存时的拦截共用这一句；
 * 预检的阻断项、画布顶部的提示、检查器的字段错误和命令行的本地检查各有自己的措辞，
 * 种类名和替换办法都取自上面的清单（命令行读它导出的 JSON）。
 */
export function removedNodesMessage(notices: readonly RemovedNodeNotice[]): string {
	const kinds = [...new Set(notices.map((n) => n.kind))];
	const replacements = kinds.map(
		(k) => `${removedKindLabel(k)}：${REMOVED_NODE_KINDS[k].replacement}`,
	);
	return `场景里有 ${notices.length} 个已不再支持的节点（${notices.map((n) => `${n.id}`).join("、")}），先删掉再保存。替换办法：${replacements.join("；")}`;
}

/**
 * 把已移除种类的节点在存下的文档里的原样内容放回解析结果：读到的文档只认它们共有的字段（解析会丢掉其余字段），
 * 而它们的配置（例如飞书通知节点发什么消息）是改写成别的做法时要读的。`parsed` 和 `stored` 的节点一一对应，
 * 顺序相同。其余节点不动。
 */
export function keepRemovedNodeConfig<T extends { nodes: readonly { kind: string }[] }>(
	parsed: T,
	stored: unknown,
): T {
	const raw =
		typeof stored === "object" &&
		stored !== null &&
		"nodes" in stored &&
		Array.isArray(stored.nodes)
			? (stored.nodes as unknown[])
			: [];
	return {
		...parsed,
		nodes: parsed.nodes.map((node, i) =>
			isRemovedNodeKind(node.kind) && typeof raw[i] === "object" && raw[i] !== null ? raw[i] : node,
		),
	} as T;
}
