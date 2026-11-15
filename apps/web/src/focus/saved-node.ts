import type { OrchestrationDocument } from "@sfly/schema";

/**
 * 画布上正在编辑的节点，在已保存的版本里是不是同一个节点类型、锁定同一个节点包版本。关注项只能引用这样的节点：
 * 控制面按已保存的最新版本检查新加的关注项（节点在不在、锁定的节点包版本有没有这张图表），
 * 新加的节点，或者改了节点类型、节点包版本的节点，要先保存成场景版本。
 */
export function isSavedNodeType(
	saved: OrchestrationDocument,
	current: OrchestrationDocument,
	nodeId: string,
): boolean {
	const was = saved.nodes.find((n) => n.id === nodeId);
	const now = current.nodes.find((n) => n.id === nodeId);
	return (
		was?.kind === "package" &&
		now?.kind === "package" &&
		was.package === now.package &&
		was.node === now.node &&
		saved.packages[was.package] === current.packages[now.package]
	);
}
