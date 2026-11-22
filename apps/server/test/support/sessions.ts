// 会话和它的事件的测试支持：直接写库造数据（会话的写接口在助手服务接上之前只返回 503）。
import { randomUUID } from "node:crypto";
import type { SessionEventBody } from "@sfly/schema";
import pg from "pg";

export const USAGE = { input: 1200, output: 80, cache_read: 900, cache_write: 0 };

/** 用户每一句话的 ID（控制面收到时分配）。 */
export const messageId = (n: number) => `5d1c0a7e-3b2f-4c68-9a41-00000000000${n}`;

const SCENARIO_ID = "6a1e4f3c-9b7d-4e58-a2c1-5d0f8e7b3a96";
const RUN_ID = "e5b8a0d2-4c36-4f19-8b7a-1d2c3e4f5a6b";

/**
 * 每种持久的事件各至少一条（`platform` 的三种、`notice` 的各种提示都有），按一轮里出现的先后排：
 * 用户说话、一轮开始、助手的消息、工具调用和结果（命令、编辑）、提示、平台留下的记录、一轮结束。
 */
export const persistedBodies = (): SessionEventBody[] => [
	{
		type: "user_message",
		message_id: messageId(1),
		text: "给 http_check 加一个超时参数",
		steer: false,
		author: "alice",
		author_user_id: null,
	},
	{ type: "turn_started", turn: 1 },
	{ type: "assistant_message", text: "我先看一下现有的节点。", usage: USAGE },
	{ type: "tool_call", call_id: "call_1", tool: "command", title: "sfly package list" },
	{
		type: "tool_result",
		call_id: "call_1",
		is_error: false,
		text: "http_check 0.3.0\n",
		truncated: false,
		exit_code: 0,
		duration_ms: 420,
	},
	{ type: "tool_call", call_id: "call_2", tool: "edit", title: "nodes/http_check.py" },
	{
		type: "tool_result",
		call_id: "call_2",
		is_error: false,
		text: "Successfully replaced 1 block(s) in nodes/http_check.py.",
		truncated: false,
		diff: "--- a/nodes/http_check.py\n+++ b/nodes/http_check.py\n@@ -1 +1 @@\n-a\n+b\n",
		duration_ms: 12,
	},
	{
		type: "notice",
		kind: "retry",
		message: "模型限流，正在重试",
		attempt: 1,
		max_attempts: 3,
		retry_delay_ms: 2000,
		error_class: "rate_limit",
	},
	{ type: "notice", kind: "compaction", message: "上下文太长，已经压缩" },
	{
		type: "platform",
		kind: "commit",
		turn: 1,
		hash: "3f1c2ab9d0e4",
		files: [
			{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
			{ path: "assets/logo.png", additions: null, deletions: null },
		],
		diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n",
		truncated: false,
	},
	{
		type: "platform",
		kind: "scenario_version",
		turn: 1,
		scenario_id: SCENARIO_ID,
		name: "接口巡检",
		version: 3,
	},
	{ type: "platform", kind: "run", turn: 1, run_id: RUN_ID, scenario_name: "接口巡检" },
	{
		type: "turn_end",
		turn: 1,
		outcome: "completed",
		reason: "助手已完成",
		steps: 12,
		model_calls: 9,
		duration_ms: 84_000,
		usage: USAGE,
	},
	{ type: "session_ended", by: "alice" },
];

/** 一个会话的种子：状态、标题、发起人，以及它的持久事件（序号从 1 起，时间从 `at` 起每条晚一秒）。 */
export interface SeededSession {
	project?: string;
	title?: string;
	status?: "idle" | "running" | "queued" | "ended";
	createdBy?: string;
	createdAt?: Date;
	lastActivityAt?: Date;
	/** 此刻在做的那一轮（会话表的 `current_turn`）；不写时是事件里 `turn_started` 的条数，和控制面自己写的一样。 */
	currentTurn?: number;
	events?: readonly SessionEventBody[];
	/** 第一条事件的时间。 */
	at?: Date;
}

/** 在库里造一个会话和它的事件；返回会话 ID。 */
export async function seedSession(databaseUrl: string, seed: SeededSession = {}): Promise<string> {
	const id = randomUUID();
	const at = seed.at ?? new Date("2026-01-01T00:00:00Z");
	const events = seed.events ?? [];
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await client.query(
			`insert into sessions (id, project_id, title, status, created_by, created_at, last_activity_at, current_turn)
			values ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				id,
				seed.project ?? "default",
				seed.title ?? "给 http_check 加超时",
				seed.status ?? "idle",
				seed.createdBy ?? "alice",
				seed.createdAt ?? at,
				seed.lastActivityAt ?? new Date(at.getTime() + events.length * 1000),
				seed.currentTurn ?? events.filter((event) => event.type === "turn_started").length,
			],
		);
		for (const [index, body] of events.entries()) {
			const { type, ...payload } = body;
			await client.query(
				`insert into session_events (session_id, seq, type, payload, created_at) values ($1, $2, $3, $4, $5)`,
				[id, index + 1, type, JSON.stringify(payload), new Date(at.getTime() + index * 1000)],
			);
		}
	} finally {
		await client.end();
	}
	return id;
}
