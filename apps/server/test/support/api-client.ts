import {
	type ClockOffsetView,
	type FeishuBotView,
	feishuBotsApi,
	NICKNAME_HEADER,
	runsApi,
} from "@sfly/schema";
import { expect } from "vitest";
import type { TestControlPlane } from "./test-control-plane.js";

/** 测试里调用控制面 HTTP API 的小封装。 */
export class ApiClient {
	constructor(private readonly cp: Pick<TestControlPlane, "fetch">) {}

	get(path: string): Promise<Response> {
		return this.cp.fetch(path);
	}

	post(path: string, body: unknown, nickname = "tester"): Promise<Response> {
		return this.cp.fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[NICKNAME_HEADER]: encodeURIComponent(nickname),
			},
			body: JSON.stringify(body),
		});
	}

	patch(path: string, body: unknown, nickname = "tester"): Promise<Response> {
		return this.cp.fetch(path, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				[NICKNAME_HEADER]: encodeURIComponent(nickname),
			},
			body: JSON.stringify(body),
		});
	}

	delete(path: string, nickname = "tester"): Promise<Response> {
		return this.cp.fetch(path, {
			method: "DELETE",
			headers: { [NICKNAME_HEADER]: encodeURIComponent(nickname) },
		});
	}

	/** 没有请求体的 POST（带 content-type 的空请求体会被拒绝）。 */
	postEmpty(path: string, nickname = "tester"): Promise<Response> {
		return this.cp.fetch(path, {
			method: "POST",
			headers: { [NICKNAME_HEADER]: encodeURIComponent(nickname) },
		});
	}

	async getJson<T>(path: string): Promise<T> {
		const res = await this.get(path);
		expect(res.status, `GET ${path}`).toBe(200);
		return (await res.json()) as T;
	}

	async createOrchestration(name: string): Promise<string> {
		const res = await this.post("/orchestrations", { name });
		expect(res.status).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	/** 登记一个飞书机器人（响应按 HTTP 契约解析）。 */
	async createFeishuBot(name: string, webhookUrl: string): Promise<FeishuBotView> {
		const res = await this.post("/feishu-bots", { name, webhook_url: webhookUrl });
		expect(res.status, await res.clone().text()).toBe(201);
		return feishuBotsApi.create.response.parse(await res.json());
	}

	/** 触发编排的最新版本。 */
	trigger(orchestrationId: string, params: Record<string, unknown> = {}, nickname = "tester") {
		return this.post(`/orchestrations/${orchestrationId}/runs`, { params }, nickname);
	}

	/** 触发并断言成功，返回运行 ID。 */
	async triggerOk(orchestrationId: string, params: Record<string, unknown> = {}): Promise<string> {
		const res = await this.trigger(orchestrationId, params);
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	/** 保存一份文档为新编排的第一个版本，返回编排 ID。 */
	async orchestrationWith(document: unknown, name = "test"): Promise<string> {
		const id = await this.createOrchestration(name);
		await this.saveVersion(id, document);
		return id;
	}

	/** 取消运行（#12）；清理期间再次调用即强制取消。 */
	cancel(runId: string, nickname = "tester"): Promise<Response> {
		return this.post(`/runs/${runId}/cancel`, {}, nickname);
	}

	/** 取消并断言成功，返回运行视图。 */
	async cancelOk(runId: string): Promise<RunView> {
		const res = await this.cancel(runId);
		expect(res.status, await res.clone().text()).toBe(200);
		return runsApi.cancel.response.parse(await res.json());
	}

	/** 运行视图（按 HTTP 契约解析，响应不符合契约时测试失败）。 */
	async run(runId: string): Promise<RunView> {
		return runsApi.get.response.parse(await this.getJson(`/runs/${runId}`));
	}

	/** 主链上某个节点的视图。 */
	async node(runId: string, nodeId: string): Promise<NodeView> {
		const run = await this.run(runId);
		const node = run.chains[0]?.nodes.find((n) => n.node_id === nodeId);
		if (!node) throw new Error(`node ${nodeId} not in run ${runId}`);
		return node;
	}

	/** 编排当前的最新版本号（0 = 还没有版本），保存时作为 base_version。 */
	async headVersion(orchestrationId: string): Promise<number> {
		return (await this.getJson<{ head_version: number }>(`/orchestrations/${orchestrationId}`))
			.head_version;
	}

	/** 以当前最新版本为基线保存新版本，返回版本号。 */
	async saveVersion(
		orchestrationId: string,
		document: unknown,
		nickname = "tester",
	): Promise<number> {
		const res = await this.post(
			`/orchestrations/${orchestrationId}/versions`,
			{ base_version: await this.headVersion(orchestrationId), document },
			nickname,
		);
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { number: number }).number;
	}
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
	/** 任务开始、结束时的时钟偏差（#175）；旧版本 Agent 或没有上报时为 null。 */
	start_clock_offset: ClockOffsetView | null;
	end_clock_offset: ClockOffsetView | null;
	/** 定时 / Sleep 节点的唤醒时间（#14）；其他节点为 null。 */
	wake_at: string | null;
	progress: {
		current: number;
		total: number | null;
		message: string;
		/** 控制面时间；升级之前保存的进度为 null。 */
		time: string | null;
		agent_time: string | null;
	} | null;
}

export interface NodeView {
	node_id: string;
	kind: string;
	status: string;
	agent: string | null;
	outputs: Record<string, unknown> | null;
	error: { kind: string; message: string } | null;
	attempts: AttemptView[];
}

export interface ChainView {
	id: string;
	chain_id: string;
	/** 子流程名称；主链为 null。 */
	name: string | null;
	parent_chain_instance_id: string | null;
	async_node_id: string | null;
	status: string;
	depth: number;
	started_at: string;
	ended_at: string | null;
	params: Record<string, unknown>;
	nodes: NodeView[];
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
	cancel: { requested_by: string; requested_at: string; forced_at: string | null } | null;
	/** 运行通知的状态（#232）；没有发运行通知时为 null。 */
	run_notification: {
		status: "queued" | "delivered" | "failed" | "discarded" | "not_sent";
		bot: string;
		reason: string | null;
	} | null;
	chains: ChainView[];
}
