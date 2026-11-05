import type { OrchestrationDocument } from "@sfly/schema";
import { packagesApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { edgeTypes } from "#/canvas/edges";
import { type SfEdge, type SfNode, toFlow } from "#/canvas/flow";
import { CanvasContext, type CanvasInfo, nodeTypes } from "#/canvas/NodeCard";
import { type RegionRunInfo, SubflowRegions } from "#/canvas/SubflowRegions";
import { apiQuery } from "#/lib/api";
import type { NodeRunView } from "./api";

/** 包节点类型的标题（来自节点包元信息）。 */
export function usePackageTitles() {
	const packages = useQuery(apiQuery(packagesApi.list));
	return useMemo(() => {
		const titles = new Map<string, string>();
		for (const pkg of packages.data?.packages ?? []) {
			for (const v of pkg.versions) {
				for (const n of v.nodes) {
					const key = `${pkg.name}/${n.name}`;
					if (!titles.has(key)) titles.set(key, n.title);
				}
			}
		}
		return titles;
	}, [packages.data]);
}

/**
 * 运行模式的画布：按运行绑定的编排版本渲染，节点卡片和连线显示运行状态。
 * 不能移动、连线或删除；点击节点选中它（查看详情），点击空白处取消选中。
 */
export function RunCanvas({
	document,
	states,
	now,
	selected,
	onSelect,
	regions,
}: {
	document: OrchestrationDocument;
	states: Map<string, NodeRunView>;
	/** 当前时间（运行中每秒更新），节点卡片上执行中任务的耗时随之刷新。 */
	now: number;
	selected: string | null;
	onSelect: (nodeId: string | null) => void;
	/** 子流程区域上显示的实例状态（主链和每个子流程实例分别显示）。 */
	regions: RegionRunInfo;
}) {
	const titles = usePackageTitles();
	const base = useMemo(() => toFlow(document), [document]);
	const nodes = useMemo(
		() => base.nodes.map((n) => ({ ...n, selected: n.id === selected })),
		[base, selected],
	);
	const info: CanvasInfo = useMemo(
		() => ({
			defaultAgent: document.default_agent,
			titleOf: (pkg, node) => titles.get(`${pkg}/${node}`),
			packages: document.packages,
			warnings: new Map(),
			run: states,
			now,
		}),
		[document, titles, states, now],
	);

	return (
		<CanvasContext.Provider value={info}>
			<ReactFlowProvider>
				<div className="sf-canvas h-full w-full">
					<ReactFlow<SfNode, SfEdge>
						nodes={nodes}
						edges={base.edges}
						nodeTypes={nodeTypes}
						edgeTypes={edgeTypes}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable={false}
						deleteKeyCode={null}
						onNodeClick={(_e, node) => onSelect(node.id)}
						onPaneClick={() => onSelect(null)}
						fitView
						fitViewOptions={{ maxZoom: 1 }}
						minZoom={0.1}
					>
						<SubflowRegions run={regions} />
						<Background gap={22} size={1.3} />
						<Controls showInteractive={false} />
						<MiniMap pannable zoomable />
					</ReactFlow>
				</div>
			</ReactFlowProvider>
		</CanvasContext.Provider>
	);
}
