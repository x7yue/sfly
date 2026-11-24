import { PERSISTED_SESSION_EVENT_TYPES, type SessionEventBody } from "../../src/index.js";

/** 用户每一句话的 ID（控制面收到时分配）。 */
export const messageId = (n: number) => `5d1c0a7e-3b2f-4c68-9a41-00000000000${n}`;

/** 一次模型调用或一轮合计的 token。 */
export const usage = { input: 1200, output: 80, cache_read: 900, cache_write: 0 };

/** 持久的事件落库后多出来的两个字段。 */
export const persistedStamp = { seq: 7, at: "2026-11-21T08:00:00.000Z" };

export interface EventSample {
	/** 样例的名字（同一个 `type` 可以有几个：`notice` 的各种 `kind`、`platform` 的三种）。 */
	name: string;
	/** 事件的内容（产生事件的一方写的形状）。 */
	body: SessionEventBody;
	/** 这个样例里可以没有的字段：缺了它们仍然合法，其余字段缺了都不合法。 */
	optional: readonly string[];
	/**
	 * 助手服务的事件流里能不能出现（`AssistantEvent` 接不接受）：助手服务产生的能；用户的话、一轮开始、排队、
	 * 会话结束、快照，以及控制面才有的 `notice`、`platform` 的种类不能。控制面补的 `interrupted` 和助手服务发的形状相同，
	 * schema 分不出来，也算能。
	 */
	inAssistantStream: boolean;
}

const retryNotice = {
	type: "notice",
	kind: "retry",
	message: "模型限流，正在重试",
	attempt: 1,
	max_attempts: 3,
	retry_delay_ms: 2_000,
	error_class: "rate_limit",
} as const;

/** 每种事件至少一个合法样例；`notice` 的每种 `kind`、`platform` 的每种 `kind`、`turn_end` 的每种 `outcome` 各有一个。 */
export const eventSamples: readonly EventSample[] = [
	{
		name: "user_message",
		body: {
			type: "user_message",
			message_id: messageId(1),
			text: "给 http_check 加一个超时参数",
			steer: false,
			author: "alice",
			author_user_id: null,
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "user_message（插话，有用户 ID）",
		body: {
			type: "user_message",
			message_id: messageId(2),
			text: "先别改测试",
			steer: true,
			author: "alice",
			author_user_id: "9b2d5c1e-6a47-4f0e-8d3a-0c1f2b3a4d5e",
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "turn_started",
		body: { type: "turn_started", turn: 1 },
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "turn_queued",
		body: {
			type: "turn_queued",
			position: 1,
			waiting_for: {
				session_id: "0c9d6b0a-2f4e-4a53-9e6b-7d1f3a5c8e21",
				title: "修复登录页",
				created_by: "bob",
			},
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "thinking",
		body: { type: "thinking" },
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "assistant_delta",
		body: { type: "assistant_delta", text: "我先看一下" },
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "assistant_message",
		body: { type: "assistant_message", text: "我先看一下现有的节点。", usage },
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "tool_call",
		body: { type: "tool_call", call_id: "call_1", tool: "command", title: "sfly package list" },
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "tool_output",
		body: { type: "tool_output", call_id: "call_1", text: "http_check 0.3.0\n" },
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "tool_result（命令）",
		body: {
			type: "tool_result",
			call_id: "call_1",
			is_error: false,
			text: "http_check 0.3.0\n",
			truncated: false,
			exit_code: 0,
			duration_ms: 420,
		},
		optional: ["exit_code", "diff"],
		inAssistantStream: true,
	},
	{
		name: "tool_result（编辑，有差异，被截断）",
		body: {
			type: "tool_result",
			call_id: "call_2",
			is_error: false,
			text: "Successfully replaced 1 block(s) in nodes/http_check.py.",
			truncated: true,
			diff: "--- a/nodes/http_check.py\n+++ b/nodes/http_check.py\n@@ -1 +1 @@\n-a\n+b\n",
			duration_ms: 12,
		},
		optional: ["exit_code", "diff"],
		inAssistantStream: true,
	},
	{
		name: "steer_queue",
		body: {
			type: "steer_queue",
			messages: [
				{ message_id: messageId(2), text: "先别改测试" },
				// 连发两句相同的话：靠 message_id 分得清。
				{ message_id: messageId(3), text: "再加一条日志" },
				{ message_id: messageId(4), text: "再加一条日志" },
			],
		},
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "notice：retry",
		body: retryNotice,
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "notice：retry_end",
		body: { type: "notice", kind: "retry_end", message: "重试成功" },
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "notice：compaction",
		body: { type: "notice", kind: "compaction", message: "上下文太长，已经压缩" },
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "notice：steer_dropped",
		body: {
			type: "notice",
			kind: "steer_dropped",
			message: "这句插话没有送到助手：「先别改测试」",
			message_id: messageId(2),
		},
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "notice：context_reset",
		body: { type: "notice", kind: "context_reset", message: "接不上之前的上下文，换成了一段摘要" },
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "notice：queue_cancelled（控制面产生）",
		body: {
			type: "notice",
			kind: "queue_cancelled",
			message: "这句话排队时被取消了，没有交给助手",
			message_id: messageId(5),
		},
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: false,
	},
	{
		name: "notice：events_lost（控制面产生）",
		body: {
			type: "notice",
			kind: "events_lost",
			message: "和助手服务断开太久，这一段过程没有记下",
		},
		optional: ["attempt", "max_attempts", "retry_delay_ms", "error_class"],
		inAssistantStream: false,
	},
	{
		name: "turn_end：completed",
		body: {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 12,
			model_calls: 9,
			duration_ms: 84_000,
			usage,
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：stopped",
		body: {
			type: "turn_end",
			turn: 2,
			outcome: "stopped",
			reason: "用户停止",
			steps: 3,
			model_calls: 3,
			duration_ms: 9_000,
			usage,
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：limit",
		body: {
			type: "turn_end",
			turn: 3,
			outcome: "limit",
			reason: "一轮最多 40 次模型调用",
			steps: 40,
			model_calls: 40,
			duration_ms: 300_000,
			usage,
			limit_kind: "model_calls",
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：limit（用时）",
		body: {
			type: "turn_end",
			turn: 3,
			outcome: "limit",
			reason: "一轮最多 20 分钟",
			steps: 25,
			model_calls: 26,
			duration_ms: 1_200_000,
			usage,
			limit_kind: "duration",
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：model_unavailable",
		body: {
			type: "turn_end",
			turn: 4,
			outcome: "model_unavailable",
			reason: "模型的密钥被拒绝",
			steps: 0,
			model_calls: 1,
			duration_ms: 800,
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
			error_class: "auth",
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：interrupted（助手服务发的：pi 进程在这一轮里退出了）",
		body: {
			type: "turn_end",
			turn: 5,
			outcome: "interrupted",
			reason: "pi 进程在这一轮里退出了",
			steps: 4,
			model_calls: 4,
			duration_ms: 31_000,
			usage,
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：interrupted（控制面补的：助手服务重启了，没有 steps、model_calls、usage）",
		body: {
			type: "turn_end",
			turn: 5,
			outcome: "interrupted",
			reason: "助手服务重启了",
			duration_ms: 31_000,
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "turn_end：failed",
		body: {
			type: "turn_end",
			turn: 6,
			outcome: "failed",
			reason: "助手服务内部错误",
			steps: 7,
			model_calls: 6,
			duration_ms: 20_000,
			usage,
		},
		optional: ["steps", "model_calls", "usage", "limit_kind", "error_class"],
		inAssistantStream: true,
	},
	{
		name: "platform：commit",
		body: {
			type: "platform",
			kind: "commit",
			turn: 2,
			hash: "3f1c2ab9d0e4",
			files: [
				{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
				{ path: "assets/logo.png", additions: null, deletions: null },
			],
			diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n",
			truncated: false,
		},
		optional: [],
		inAssistantStream: true,
	},
	{
		name: "platform：scenario_version",
		body: {
			type: "platform",
			kind: "scenario_version",
			turn: 2,
			scenario_id: "6a1e4f3c-9b7d-4e58-a2c1-5d0f8e7b3a96",
			name: "接口巡检",
			version: 3,
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "platform：run",
		body: {
			type: "platform",
			kind: "run",
			turn: 2,
			run_id: "e5b8a0d2-4c36-4f19-8b7a-1d2c3e4f5a6b",
			scenario_name: "接口巡检",
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "session_ended",
		body: { type: "session_ended", by: "alice" },
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "snapshot",
		body: {
			type: "snapshot",
			status: "running",
			partial_text: "我先看一下",
			running_tool: {
				call_id: "call_3",
				tool: "command",
				title: "sfly run start 接口巡检",
				output: "…\n",
			},
			steer_queue: [{ message_id: messageId(2), text: "先别改测试" }],
			waiting_for: null,
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "snapshot（没有在跑的工具）",
		body: {
			type: "snapshot",
			status: "idle",
			partial_text: "",
			running_tool: null,
			steer_queue: [],
			waiting_for: null,
		},
		optional: [],
		inAssistantStream: false,
	},
	{
		name: "snapshot（排队中，在等谁）",
		body: {
			type: "snapshot",
			status: "queued",
			partial_text: "",
			running_tool: null,
			steer_queue: [],
			waiting_for: {
				session_id: "0c9d6b0a-2f4e-4a53-9e6b-7d1f3a5c8e21",
				title: "修复登录页",
				created_by: "bob",
			},
		},
		optional: [],
		inAssistantStream: false,
	},
];

const persisted = new Set<string>(PERSISTED_SESSION_EVENT_TYPES);

/** 这个事件是不是持久的（落库时带 `seq`、`at`）。 */
export const isPersistedBody = (body: SessionEventBody): boolean => persisted.has(body.type);

/** 读事件的一方看到的形状：持久的多 `seq`、`at`。 */
export function asReaderEvent(body: SessionEventBody): Record<string, unknown> {
	return isPersistedBody(body) ? { ...body, ...persistedStamp } : { ...body };
}
