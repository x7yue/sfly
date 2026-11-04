import type { OrchestrationNode } from "@sfly/schema";
import { apiGet, apiPost } from "#/lib/api";

/** 运行相关的控制面 API（#9）。字段与 apps/server/src/engine/run-queries.ts 一致。 */

export type ParamDecl = Extract<OrchestrationNode, { kind: "entry" }>["params"][number];

/** 不能触发的一个原因。 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

export interface Preflight {
	/** 最新版本号（触发运行绑定的版本）；0 表示还没有版本。 */
	version: number;
	/** 入口节点的参数声明，用来生成触发表单。 */
	params: ParamDecl[];
	problems: PreflightProblem[];
}

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
	chains: ChainRunView[];
}

export type RunSummary = Omit<RunView, "params" | "chains">;

export const getPreflight = (orchestrationId: string) =>
	apiGet<Preflight>(`/orchestrations/${orchestrationId}/preflight`);

/** 触发编排的最新版本。预检不通过时 400 `invalid_orchestration`（details 是原因列表），参数不对时 400 `invalid_params`。 */
export const triggerRun = (orchestrationId: string, params: Record<string, unknown>) =>
	apiPost<RunView>(`/orchestrations/${orchestrationId}/runs`, { params });

export const listRuns = (orchestrationId: string) =>
	apiGet<{ runs: RunSummary[] }>(`/orchestrations/${orchestrationId}/runs`);

export const getRun = (runId: string) => apiGet<RunView>(`/runs/${runId}`);

/** 运行的 SSE 流：连上时和每次状态变化时推送完整的运行视图（事件 `run`）。 */
export const runEventsPath = (runId: string) => `/runs/${runId}/events`;
