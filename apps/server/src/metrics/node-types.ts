import {
	DEV_VERSION,
	NodeTypeMetadata,
	type PackageMetadata,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { agents, nodePackages } from "../db/schema.js";
import { type NodeTypeView, withDefaultCharts } from "../packages/default-charts.js";

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
	db: Db | Tx,
	document: StoredOrchestrationDocument,
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

/**
 * 节点类型的元信息校验后加上默认图表（平台为没被图表引用的指标生成的）；没有或者不合法时为 undefined（开发版本的元信息是
 * Agent 上报的，没经过发布校验）。
 */
export function nodeTypeView(type: NodeTypeRef["type"]): NodeTypeView | undefined {
	const parsed = NodeTypeMetadata.safeParse(type);
	return parsed.success ? withDefaultCharts(parsed.data) : undefined;
}

/**
 * 文档里 `nodeId` 这个节点的节点类型（图表含平台为没被图表引用的指标生成的默认图表）；节点不是包节点、锁定的节点包版本找不到、
 * 或者元信息不合法时为 undefined。开发版本取 `agentName`（没给时是节点所在的 Agent）当前加载的源码，
 * 不一定是运行当时的定义。
 */
export async function declaredNodeType(
	db: Db | Tx,
	document: StoredOrchestrationDocument,
	nodeId: string,
	agentName?: string | null,
): Promise<NodeTypeView | undefined> {
	const node = document.nodes.find((n) => n.id === nodeId);
	if (node?.kind !== "package") return undefined;
	const ref = await nodeTypeOf(
		db,
		document,
		nodeId,
		agentName ?? node.agent ?? document.default_agent ?? null,
	);
	return nodeTypeView(ref?.type);
}
