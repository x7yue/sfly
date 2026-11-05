import { type OrchestrationDocument, queryKey, type RunView, runsApi } from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { type SfNode, toFlow } from "#/canvas/flow";
import { apiQuery } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import { getVersion } from "#/versions/api";
import { type RunOverlay, runOverlay } from "./run-overlay";

export type CanvasRun =
	| { status: "loading" }
	| { status: "none" }
	| { status: "error"; error: Error }
	| {
			status: "ready";
			run: RunView;
			overlay: RunOverlay;
			/** 运行绑定的版本文档（画布在运行状态下显示这一版）；还在加载时为 undefined。 */
			doc: OrchestrationDocument | undefined;
	  };

/**
 * 画布「运行状态」模式的数据：指定的运行（从监控页带入），否则这个场景最近一次运行；
 * 运行中通过 SSE 实时更新（只订阅 run 事件）。enabled 为 false（编辑模式）时不请求。
 */
export function useCanvasRun(
	orchestrationId: string,
	runId: string | undefined,
	enabled: boolean,
): CanvasRun {
	const queryClient = useQueryClient();
	const latest = useQuery({
		...apiQuery(runsApi.listForOrchestration, { params: { id: orchestrationId } }),
		enabled: enabled && !runId,
	});
	const id = runId ?? latest.data?.runs[0]?.id;
	const runQuery = useQuery({
		...apiQuery(runsApi.get, { params: { id: id ?? "" } }),
		enabled: enabled && !!id,
	});
	const run = runQuery.data;
	useEventSource(
		enabled && run?.status === "running" ? `/runs/${encodeURIComponent(run.id)}/events` : null,
		{
			run: (data) =>
				queryClient.setQueryData(
					queryKey(runsApi.get, { params: { id: (data as RunView).id } }),
					data as RunView,
				),
		},
	);
	// 与运行监控页共用同一个缓存键。
	const version = useQuery({
		queryKey: ["orchestration", orchestrationId, "version", run?.orchestration_version],
		queryFn: () => getVersion(orchestrationId, run?.orchestration_version as number),
		enabled: enabled && !!run,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const overlay = useMemo(() => (run ? runOverlay(run) : undefined), [run]);

	if (run && overlay) {
		return { status: "ready", run, overlay, doc: version.data?.document };
	}
	const error = runId ? runQuery.error : (latest.error ?? runQuery.error);
	if (error) return { status: "error", error };
	if (!runId && latest.data && latest.data.runs.length === 0) return { status: "none" };
	return { status: "loading" };
}

/**
 * 运行状态下画布显示的节点与连线（运行绑定的版本文档）。节点由 React Flow 测量尺寸（小地图需要），
 * 所以放在本地状态里接收尺寸变化；文档变化时重建。doc 为 undefined（还在加载）时返回 undefined。
 */
export function useRunFlow(doc: OrchestrationDocument | undefined) {
	const initial = useMemo(() => (doc ? toFlow(doc) : undefined), [doc]);
	const [from, setFrom] = useState(initial);
	const [nodes, setNodes] = useState(initial?.nodes);
	if (from !== initial) {
		setFrom(initial);
		setNodes(initial?.nodes);
	}
	const onNodesChange = useCallback(
		(changes: NodeChange<SfNode>[]) => setNodes((ns) => ns && applyNodeChanges(changes, ns)),
		[],
	);
	return initial && nodes ? { nodes, edges: initial.edges, onNodesChange } : undefined;
}
