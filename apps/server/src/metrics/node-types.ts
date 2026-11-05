import type { OrchestrationDocument, PackageMetadata } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents, nodePackages } from "../db/schema.js";

const DEV_VERSION = "dev";

/** 包节点引用的节点类型。 */
export interface NodeTypeRef {
	package: string;
	node: string;
	/** 场景锁定的版本；`dev` 表示开发版本。 */
	version: string;
	/**
	 * 节点类型的元信息：锁定的节点包版本；开发版本取 agentName 这个 Agent 当前加载的源码声明
	 * （Agent 上报，未经发布校验）。找不到时为 undefined。
	 */
	type: PackageMetadata["nodes"][number] | undefined;
}

/** 场景中 nodeId 这个包节点的节点类型；不是包节点时为 undefined。 */
export async function nodeTypeOf(
	db: Db,
	document: OrchestrationDocument,
	nodeId: string,
	agentName: string | null,
): Promise<NodeTypeRef | undefined> {
	const node = document.nodes.find((n) => n.id === nodeId);
	if (node?.kind !== "package") return undefined;
	const version = document.packages[node.package] ?? "";
	let metadata: PackageMetadata | undefined;
	if (version === DEV_VERSION) {
		if (agentName) {
			const [agent] = await db
				.select({ info: agents.info })
				.from(agents)
				.where(eq(agents.name, agentName));
			metadata = agent?.info.dev_packages?.find((p) => p.name === node.package)?.metadata as
				| PackageMetadata
				| undefined;
		}
	} else {
		const [pkg] = await db
			.select({ metadata: nodePackages.metadata })
			.from(nodePackages)
			.where(and(eq(nodePackages.name, node.package), eq(nodePackages.version, version)));
		metadata = pkg?.metadata;
	}
	const type = metadata?.nodes?.find((n) => n.name === node.node);
	return { package: node.package, node: node.node, version, type };
}
