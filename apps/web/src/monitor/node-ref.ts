/** 时间线上的一个节点：同一个子流程可能有多个实例，所以要带链实例 ID。 */
export interface NodeRef {
	chainInstanceId: string;
	nodeId: string;
}

export const sameNode = (a: NodeRef | null, b: NodeRef | null) =>
	a?.chainInstanceId === b?.chainInstanceId && a?.nodeId === b?.nodeId;

/** 节点在筛选集合里的键。 */
export const nodeKey = (node: NodeRef) => `${node.chainInstanceId}:${node.nodeId}`;
