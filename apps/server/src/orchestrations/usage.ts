import type { OrchestrationDocument } from "@sfly/schema";

/**
 * 场景对 Agent 与节点包版本的使用情况，按各场景的最新版本统计（Agent 管理、节点包管理页面用）。
 * 还没有保存过版本的场景不计入。
 */

/** Agent 名 → 引用它的场景数（默认 Agent 或节点另选的 Agent；同一场景只算一次）。 */
export function agentReferences(documents: readonly OrchestrationDocument[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const doc of documents) {
		const names = new Set<string>();
		if (doc.default_agent) names.add(doc.default_agent);
		for (const node of doc.nodes) {
			if (node.kind === "package" && node.agent) names.add(node.agent);
		}
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return counts;
}

/** `包名@版本` → 锁定这个版本的场景数。 */
export function packageLocks(documents: readonly OrchestrationDocument[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const doc of documents) {
		for (const [name, version] of Object.entries(doc.packages ?? {})) {
			const key = `${name}@${version}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}
