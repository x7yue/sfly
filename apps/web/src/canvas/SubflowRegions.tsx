import { chainMembers } from "@sfly/orchestration";
import { useEdges, useNodes, ViewportPortal } from "@xyflow/react";
import { useMemo } from "react";
import type { ChainRunView } from "#/runs/api";
import { runStatusLabel, shortId, statusTone } from "#/runs/format";
import type { SfEdge, SfNode } from "./flow";

/** 节点卡片的默认尺寸（还没测量到时用，与 tokens.css 的 --sf-node-w / -h 一致）。 */
const NODE_W = 208;
const NODE_H = 128;

/** 运行模式下子流程区域需要的信息：每个子流程的实例，以及当前显示的是哪一个。 */
export interface RegionRunInfo {
	/** 子流程入口节点 ID → 该子流程在这次运行中的实例（按开始时间）。 */
	instances: ReadonlyMap<string, ChainRunView[]>;
	/** 子流程入口节点 ID → 画布上显示的实例 ID（没有时显示第一个）。 */
	picked: Readonly<Record<string, string>>;
	onPick(chainId: string, instanceId: string): void;
}

interface Region {
	id: string;
	trigger: string | undefined;
	count: number;
	box: { x: number; y: number; w: number; h: number };
}

/**
 * 子流程区域（原型 canvas.css 的 .region）：每个子流程入口节点及它链上的节点外面一圈紫色虚线框，
 * 标题行写子流程 ID 和触发它的异步任务节点；运行模式下显示该子流程实例的状态。
 * 放在 ReactFlow 的子元素里使用，框画在节点和连线下面。
 */
export function SubflowRegions({ run }: { run?: RegionRunInfo }) {
	const nodes = useNodes<SfNode>();
	const edges = useEdges<SfEdge>();
	const regions = useMemo((): Region[] => {
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const members = chainMembers({
			nodes: nodes.map((n) => ({ id: n.id, kind: n.data.node.kind })),
			edges: edges.map((e) => ({ from: e.source, to: e.target, kind: e.data?.kind ?? "chain" })),
		});
		const out: Region[] = [];
		for (const [start, ids] of members) {
			if (byId.get(start)?.data.node.kind !== "subflow_entry") continue;
			const boxes = ids.flatMap((id) => {
				const n = byId.get(id);
				if (!n) return [];
				const w = n.measured?.width ?? NODE_W;
				const h = n.measured?.height ?? NODE_H;
				return [{ x0: n.position.x, y0: n.position.y, x1: n.position.x + w, y1: n.position.y + h }];
			});
			// 与原型 regionBox 一致：左 40、上 42（标题行）、右 32、下 18。
			const x = Math.min(...boxes.map((b) => b.x0)) - 40;
			const y = Math.min(...boxes.map((b) => b.y0)) - 42;
			const x1 = Math.max(...boxes.map((b) => b.x1)) + 32;
			const y1 = Math.max(...boxes.map((b) => b.y1)) + 18;
			out.push({
				id: start,
				trigger: edges.find((e) => e.target === start && e.data?.kind === "dispatch")?.source,
				count: ids.length,
				box: { x, y, w: x1 - x, h: y1 - y },
			});
		}
		return out;
	}, [nodes, edges]);

	return (
		<ViewportPortal>
			{regions.map((r) => (
				<section
					key={r.id}
					className="sf-region"
					aria-label={`子流程 ${r.id}`}
					style={{ left: r.box.x, top: r.box.y, width: r.box.w, height: r.box.h }}
				>
					<div className="sf-region__head">
						<span className="sf-region__t">子流程</span>
						<span className="sf-region__id">{r.id}</span>
						{run ? (
							<RegionRunState chainId={r.id} run={run} />
						) : (
							<span className="sf-region__meta">
								{r.trigger ? `由 ${r.trigger} 触发` : "没有异步任务节点触发"} · {r.count} 个节点
							</span>
						)}
					</div>
				</section>
			))}
		</ViewportPortal>
	);
}

/** 运行模式的标题行右侧：子流程实例的状态；有多个实例时可以切换画布上显示的实例。 */
function RegionRunState({ chainId, run }: { chainId: string; run: RegionRunInfo }) {
	const instances = run.instances.get(chainId) ?? [];
	const current = instances.find((c) => c.id === run.picked[chainId]) ?? instances[0];
	if (!current) {
		return <span className="sf-region__meta">未触发</span>;
	}
	return (
		<span className="sf-region__meta nopan nodrag">
			{instances.length > 1 ? (
				<select
					aria-label={`子流程 ${chainId} 的实例`}
					className="sf-region__pick"
					value={current.id}
					onChange={(e) => run.onPick(chainId, e.target.value)}
				>
					{instances.map((c, i) => (
						<option key={c.id} value={c.id}>
							实例 {i + 1} · {shortId(c.id)} · {runStatusLabel(c.status)}
						</option>
					))}
				</select>
			) : (
				<span className="sf-mono" title={current.id}>
					实例 {shortId(current.id)}
				</span>
			)}
			<span className={`sf-status sf-status--${statusTone(current.status)}`}>
				<i />
				{runStatusLabel(current.status)}
			</span>
		</span>
	);
}
