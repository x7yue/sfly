import type { RunView } from "@sfly/schema";
import { useEffect, useMemo, useState } from "react";
import type { FollowExecution } from "#/components/canvas/FlowCanvas";
import type { SfEdge } from "#/components/canvas/flow";
import { setFollowExecution, useFollowExecution } from "#/lib/follow-execution";
import { type EdgeFlow, liveEdgeIds, nextEdgeFlow, type RunOverlay } from "./run-overlay";

/**
 * 画布运行状态里跟着执行推进的两处动效：刚变成执行中的连线（`enteringEdges`，流动两遍）和「跟随执行」（`follow`，
 * 镜头框住执行中的节点）。`run`、`overlay`、`edges` 任何一个还没有（运行或版本文档在加载、不在运行状态）时都没有。
 * 画布每次拿到新的运行视图只对比一次上一次看到的连线；不在运行状态期间不记，切回来时已经在执行的连线是静止的。
 */
export function useRunMotion(
	run: RunView | undefined,
	overlay: RunOverlay | undefined,
	edges: readonly SfEdge[] | undefined,
) {
	const preferred = useFollowExecution();
	const ended = run !== undefined && run.status !== "running";
	const follow = useMemo(
		(): FollowExecution | undefined =>
			overlay && edges
				? {
						active: preferred && !ended,
						disabled: ended,
						running: overlay.running,
						onChange: setFollowExecution,
					}
				: undefined,
		[overlay, edges, preferred, ended],
	);

	const [flow, setFlow] = useState<{ runId: string; value: EdgeFlow } | null>(null);
	const runId = run?.id;
	useEffect(() => {
		if (!runId || !overlay || !edges) {
			setFlow(null);
			return;
		}
		const live = liveEdgeIds(overlay, edges);
		setFlow((seen) => {
			const value = nextEdgeFlow(seen?.runId === runId ? seen.value : null, live);
			return seen?.runId === runId && seen.value === value ? seen : { runId, value };
		});
	}, [runId, overlay, edges]);

	return { follow, enteringEdges: flow?.value.entering };
}
