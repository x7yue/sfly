import { isSecretDefaultPlaceholder, type OrchestrationDocument } from "@sfly/schema";

/**
 * 画布里的文档带着「已设置」的敏感默认值时，它们是读取接口给的占位符（SECRET_MASK），原值读不回来。
 * 保存到同一个场景时控制面按「沿用上一个版本的值」换回原值；存到另一个场景（另存为新场景）没有可以沿用的值，
 * 所以这里把它们去掉，需要的话到新场景里重新填写。
 */

type Entry = Extract<OrchestrationDocument["nodes"][number], { kind: "entry" | "subflow_entry" }>;

const isEntry = (node: OrchestrationDocument["nodes"][number]): node is Entry =>
	node.kind === "entry" || node.kind === "subflow_entry";

/** 文档里「已设置」的敏感默认值有几个。 */
export const countSecretPlaceholders = (doc: OrchestrationDocument): number =>
	doc.nodes.reduce(
		(sum, node) =>
			sum + (isEntry(node) ? node.params.filter(isSecretDefaultPlaceholder).length : 0),
		0,
	);

/** 去掉文档里「已设置」的敏感默认值（参数本身和别的默认值不动）。 */
export const withoutSecretPlaceholders = (doc: OrchestrationDocument): OrchestrationDocument => ({
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
});
