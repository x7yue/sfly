import type { OrchestrationNode } from "@sfly/schema";
import { apiGet } from "#/lib/api";
import type { TaskProgress } from "./logs";

/** 运行相关的控制面 API（#9）。字段与 apps/server/src/engine/run-queries.ts 一致。 */

export interface AttemptView {
	task_id: string;
	attempt: number;
	status: string;
	agent: string | null;
	inputs: Record<string, unknown> | null;
	outputs: Record<string, unknown> | null;
	error: { kind: string; message: string } | null;
	queued_at: string;
	started_at: string | null;
	ended_at: string | null;
	/** 定时 / Sleep 节点的唤醒时间（#14）；其他节点为 null。 */
	wake_at: string | null;
	/** 最新进度（#10）；没有上报过时为 null。 */
	progress: TaskProgress | null;
}

export interface NodeRunView {
	node_id: string;
	kind: OrchestrationNode["kind"];
	/** 最近一次尝试的状态；还没有尝试时为 pending。 */
	status: string;
	agent: string | null;
	outputs: Record<string, unknown> | null;
	error: { kind: string; message: string } | null;
	attempts: AttemptView[];
}

export interface ChainRunView {
	id: string;
	chain_id: string;
	parent_chain_instance_id: string | null;
	async_node_id: string | null;
	depth: number;
	status: string;
	params: Record<string, unknown>;
	started_at: string;
	ended_at: string | null;
	nodes: NodeRunView[];
}

export interface RunView {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: string;
	triggered_by: string;
	params: Record<string, unknown>;
	started_at: string;
	ended_at: string | null;
	/** 取消请求（#12）；没有被取消时为 null。forced_at：清理期间再次取消（强制取消）的时间。 */
	cancel: { requested_by: string; requested_at: string; forced_at: string | null } | null;
	chains: ChainRunView[];
}

export type RunSummary = Omit<RunView, "params" | "chains" | "cancel">;

export const listRuns = (orchestrationId: string) =>
	apiGet<{ runs: RunSummary[] }>(`/orchestrations/${orchestrationId}/runs`);

export const getRun = (runId: string) => apiGet<RunView>(`/runs/${runId}`);

/** 运行的 SSE 流：连上时和每次状态变化时推送完整的运行视图（事件 `run`），任务进度更新时推送 `progress`（logs.ts）。 */
export const runEventsPath = (runId: string) => `/runs/${runId}/events`;
