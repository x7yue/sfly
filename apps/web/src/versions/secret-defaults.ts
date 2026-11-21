import { isSecretDefaultPlaceholder, type StoredNode } from "@sfly/schema";

/**
 * 画布里的文档带着「已设置」的敏感默认值时，它们是读取接口给的占位符（SECRET_MASK），原值读不回来。
 * 保存到同一个场景时控制面按「沿用上一个版本的值」换回原值；存到另一个场景（另存为新场景）没有可以沿用的值，
 * 所以这里把它们去掉，需要的话到新场景里重新填写。
 */

type Entry = Extract<StoredNode, { kind: "entry" | "subflow_entry" }>;

/** 保存的文档和读到的文档（历史版本里可能有已移除种类的节点，ADR 0028）都行：只看入口节点，别的节点原样带着。 */
interface Doc {
	nodes: readonly StoredNode[];
}

const isEntry = (node: StoredNode): node is Entry =>
	node.kind === "entry" || node.kind === "subflow_entry";

/** 文档里「已设置」的敏感默认值有几个。 */
export const countSecretPlaceholders = (doc: Doc): number =>
	doc.nodes.reduce(
		(sum, node) =>
			sum + (isEntry(node) ? node.params.filter(isSecretDefaultPlaceholder).length : 0),
		0,
	);

/** 去掉文档里「已设置」的敏感默认值（参数本身和别的默认值不动）。 */
export const withoutSecretPlaceholders = <D extends Doc>(doc: D): D =>
	({
		...doc,
		nodes: doc.nodes.map((node) =>
			isEntry(node)
				? {
						...node,
						params: node.params.map((param) => {
							if (!isSecretDefaultPlaceholder(param)) return param;
							const { default: _removed, ...rest } = param;
							return rest;
						}),
					}
				: node,
		),
	}) as D;
