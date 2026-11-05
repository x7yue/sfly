import type { OrchestrationDocument } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { edgeTypes } from "#/canvas/edges";
import { type SfEdge, type SfNode, toFlow } from "#/canvas/flow";
import { CanvasContext, type CanvasInfo, nodeTypes } from "#/canvas/NodeCard";
import { listPackages } from "#/lib/api";

export type NodeMark = "added" | "removed" | "changed";

/** 只读画布：查看某个编排版本，不能移动、连线或选择。marks 给节点加上差异标记。 */
export function ReadOnlyCanvas({
	document,
	marks,
}: {
	document: OrchestrationDocument;
	marks?: Map<string, NodeMark>;
}) {
	const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });
	const flow = useMemo(() => {
		const { nodes, edges } = toFlow(document);
		return {
			nodes: nodes.map((n) => {
				const mark = marks?.get(n.id);
				return mark ? { ...n, className: `sf-diff-${mark}` } : n;
			}),
			edges,
		};
	}, [document, marks]);

	const info: CanvasInfo = useMemo(() => {
		const titles = new Map<string, string>();
		for (const pkg of packages.data?.packages ?? []) {
			for (const v of pkg.versions) {
				for (const n of v.nodes) {
					const key = `${pkg.name}/${n.name}`;
					if (!titles.has(key)) titles.set(key, n.title);
				}
			}
		}
		return {
			defaultAgent: document.default_agent,
			titleOf: (pkg, node) => titles.get(`${pkg}/${node}`),
			packages: document.packages,
			warnings: new Map(),
		};
	}, [document, packages.data]);

	return (
		<CanvasContext.Provider value={info}>
			<ReactFlowProvider>
				<div className="sf-canvas h-full w-full">
					<ReactFlow<SfNode, SfEdge>
						nodes={flow.nodes}
						edges={flow.edges}
						nodeTypes={nodeTypes}
						edgeTypes={edgeTypes}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable={false}
						deleteKeyCode={null}
						fitView
						fitViewOptions={{ maxZoom: 1 }}
						minZoom={0.1}
					>
						<Background gap={16} />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
			</ReactFlowProvider>
		</CanvasContext.Provider>
	);
}
