import { describe, expect, it } from "vitest";
import {
	AssistantNoticeKind,
	CreateSessionBody,
	ErrorClass,
	NoticeKind,
	PERSISTED_SESSION_EVENT_TYPES,
	PersistedSessionEvent,
	PlatformEventKind,
	ReadinessProblemKind,
	SESSION_EVENT_TYPES,
	SESSION_HISTORY_PAGE,
	SESSION_MESSAGE_MAX_CHARS,
	SendMessageBody,
	SessionDetailQuery,
	SessionDetailResponse,
	SessionErrorCode,
	SessionEvent,
	SessionEventBody,
	SessionEventsQuery,
	SessionListResponse,
	SessionStatus,
	SessionTool,
	SessionView,
	sessionEventSchemas,
	TurnOutcome,
	toJsonSchema,
} from "../src/index.js";
import {
	asReaderEvent,
	eventSamples,
	isPersistedBody,
	persistedStamp,
} from "./support/session-event-samples.js";

/** 一个按 `type` 区分的联合（里面的 `platform` 是按 `kind` 区分的联合）里，所有成员的 `type` 取值。 */
/** 去掉重复（`platform` 的三种 `kind` 各有一个成员）并排序。 */
const unique = (values: string[]): string[] => [...new Set(values)].sort();

function typesOf(union: { options: readonly unknown[] }): string[] {
	return union.options.flatMap((option) => {
		const member = option as { options?: readonly unknown[]; shape?: { type: { value: string } } };
		return member.options
			? typesOf({ options: member.options })
			: [member.shape?.type.value as string];
	});
}

const sessionId = "0c9d6b0a-2f4e-4a53-9e6b-7d1f3a5c8e21";
const readyNow = { ready: true, problems: [] };
const listItem = {
	id: sessionId,
	title: "给 http_check 加超时",
	status: "idle",
	created_by: "alice",
	created_at: "2026-11-21T08:00:00.000Z",
	last_activity_at: "2026-11-21T08:05:00.000Z",
	queue_position: null,
	last_turn_outcome: null,
};

describe("会话事件", () => {
	describe.each(eventSamples)("$name", (sample) => {
		it("内容（SessionEventBody）通过 schema，解析结果不丢字段", () => {
			expect(SessionEventBody.parse(sample.body)).toEqual(sample.body);
		});

		it("读事件的一方看到的形状（SessionEvent）通过 schema：持久的带 seq、at", () => {
			const event = asReaderEvent(sample.body);
			expect(SessionEvent.parse(event)).toEqual(event);
		});

		it("必填的字段缺了就被拒绝（可以没有的字段缺了仍然合法）", () => {
			const event = asReaderEvent(sample.body);
			const keys = Object.keys(event).filter((key) => key !== "type");
			for (const key of keys) {
				const without = { ...event };
				delete without[key];
				const optional = sample.optional.includes(key);
				expect(
					SessionEvent.safeParse(without).success,
					`${sample.name} 缺了 ${key}${optional ? "：这个字段可以没有" : "：必填的字段缺了应该被拒绝"}`,
				).toBe(optional);
			}
		});

		it("字段的类型不对就被拒绝：每个字段换成另一种 JSON 类型", () => {
			const event = asReaderEvent(sample.body);
			for (const [key, value] of Object.entries(event).filter(([key]) => key !== "type")) {
				// 字符串换成数字，数字、布尔、数组、对象、null 换成字符串 "x"（字符串字段本来就收字符串，所以单独处理）；
				// 可以为 null 的字符串字段（author_user_id）换成数字。
				const wrong = typeof value === "string" || value === null ? 123 : "x";
				expect(
					SessionEvent.safeParse({ ...event, [key]: wrong }).success,
					`${sample.name} 的 ${key} 换成 ${JSON.stringify(wrong)}`,
				).toBe(false);
			}
		});

		it("持久的事件没有 seq 或 at 就被拒绝，不存的事件不要求", () => {
			const { seq: _seq, ...withoutSeq } = asReaderEvent(sample.body);
			const { at: _at, ...withoutAt } = asReaderEvent(sample.body);
			const persisted = isPersistedBody(sample.body);
			expect(SessionEvent.safeParse(withoutSeq).success).toBe(!persisted);
			expect(SessionEvent.safeParse(withoutAt).success).toBe(!persisted);
		});

		it("PersistedSessionEvent（历史接口返回的）只收持久的事件", () => {
			const event = { ...sample.body, ...persistedStamp };
			expect(PersistedSessionEvent.safeParse(event).success).toBe(isPersistedBody(sample.body));
		});
	});

	it("每种类型都有样例，样例里没有不认识的类型", () => {
		expect([...new Set(eventSamples.map((s) => s.body.type))].sort()).toEqual(
			[...SESSION_EVENT_TYPES].sort(),
		);
	});

	it("类型的列表、持久的类型和 schema 里的完全一致：后面的任务不需要再加类型", () => {
		expect([...SESSION_EVENT_TYPES]).toEqual([
			"user_message",
			"turn_started",
			"turn_queued",
			"thinking",
			"assistant_delta",
			"assistant_message",
			"tool_call",
			"tool_output",
			"tool_result",
			"steer_queue",
			"notice",
			"turn_end",
			"platform",
			"session_ended",
			"snapshot",
		]);
		expect([...PERSISTED_SESSION_EVENT_TYPES]).toEqual([
			"user_message",
			"turn_started",
			"assistant_message",
			"tool_call",
			"tool_result",
			"notice",
			"turn_end",
			"platform",
			"session_ended",
		]);
		// 从 schema 自己取出判别值来比：schema 里多一个、少一个类型，常量没跟着改，这里就会失败。
		expect(unique(typesOf(SessionEvent))).toEqual([...SESSION_EVENT_TYPES].sort());
		expect(unique(typesOf(SessionEventBody))).toEqual([...SESSION_EVENT_TYPES].sort());
		expect(unique(typesOf(PersistedSessionEvent))).toEqual(
			[...PERSISTED_SESSION_EVENT_TYPES].sort(),
		);
		expect(Object.keys(sessionEventSchemas).sort()).toEqual([...SESSION_EVENT_TYPES].sort());
		expect([...new Set(SESSION_EVENT_TYPES)].length).toBe(SESSION_EVENT_TYPES.length);
	});

	it("sessionEventSchemas：每种事件一个 schema，样例能过，持久的要 seq 和 at（接口定义的 stream 用它）", () => {
		for (const sample of eventSamples) {
			const schema = sessionEventSchemas[sample.body.type];
			const event = asReaderEvent(sample.body);
			expect(schema.safeParse(event).success, sample.name).toBe(true);
			expect(schema.safeParse(sample.body).success, `${sample.name} 不带 seq、at`).toBe(
				!isPersistedBody(sample.body),
			);
		}
	});

	it("不认识的 type、没有 type、platform 不认识的 kind、notice 不认识的 kind 都被拒绝", () => {
		expect(SessionEventBody.safeParse({ type: "thinking_end" }).success).toBe(false);
		expect(SessionEventBody.safeParse({}).success).toBe(false);
		expect(SessionEvent.safeParse({ type: "agent_settled" }).success).toBe(false);
		expect(SessionEventBody.safeParse({ type: "platform", kind: "deploy" }).success).toBe(false);
		expect(
			SessionEventBody.safeParse({ type: "notice", kind: "model_switched", message: "x" }).success,
		).toBe(false);
	});

	it("取值的集合：turn_end 的 outcome、notice 的 kind、platform 的 kind、error_class、工具", () => {
		expect(TurnOutcome.options).toEqual([
			"completed",
			"stopped",
			"limit",
			"model_unavailable",
			"interrupted",
			"failed",
		]);
		expect(NoticeKind.options).toEqual([
			"retry",
			"retry_end",
			"compaction",
			"steer_dropped",
			"queue_cancelled",
			"events_lost",
			"context_reset",
		]);
		expect(AssistantNoticeKind.options).toEqual([
			"retry",
			"retry_end",
			"compaction",
			"steer_dropped",
			"context_reset",
		]);
		expect(PlatformEventKind.options).toEqual(["commit", "scenario_version", "run"]);
		expect(ErrorClass.options).toEqual([
			"unreachable",
			"timeout",
			"auth",
			"quota",
			"rate_limit",
			"upstream",
			"context_overflow",
			"other",
		]);
		expect(SessionTool.options).toEqual(["read", "write", "edit", "bash"]);
	});

	it("样例覆盖每个 outcome、notice kind、platform kind，error_class 和工具各取值都能过 schema", () => {
		const outcomes = eventSamples.flatMap((s) =>
			s.body.type === "turn_end" ? [s.body.outcome] : [],
		);
		expect(new Set(outcomes)).toEqual(new Set(TurnOutcome.options));
		const kinds = eventSamples.flatMap((s) => (s.body.type === "notice" ? [s.body.kind] : []));
		expect(new Set(kinds)).toEqual(new Set(NoticeKind.options));
		const platform = eventSamples.flatMap((s) => (s.body.type === "platform" ? [s.body.kind] : []));
		expect(new Set(platform)).toEqual(new Set(PlatformEventKind.options));
		for (const errorClass of ErrorClass.options) {
			expect(
				SessionEventBody.safeParse({
					type: "notice",
					kind: "retry",
					message: "x",
					error_class: errorClass,
				}).success,
			).toBe(true);
			expect(
				SessionEventBody.safeParse({
					type: "turn_end",
					turn: 1,
					outcome: "model_unavailable",
					reason: "x",
					duration_ms: 1,
					error_class: errorClass,
				}).success,
			).toBe(true);
		}
		for (const tool of SessionTool.options) {
			expect(
				SessionEventBody.safeParse({ type: "tool_call", call_id: "c", tool, title: "t" }).success,
			).toBe(true);
		}
		expect(
			SessionEventBody.safeParse({ type: "tool_call", call_id: "c", tool: "grep", title: "t" })
				.success,
		).toBe(false);
	});

	it("platform 记录里的场景和运行用 UUID", () => {
		const scenario = eventSamples.find((s) => s.name === "platform：scenario_version")?.body;
		const run = eventSamples.find((s) => s.name === "platform：run")?.body;
		expect(scenario).toBeDefined();
		expect(run).toBeDefined();
		expect(SessionEventBody.safeParse({ ...scenario, scenario_id: "42" }).success).toBe(false);
		expect(SessionEventBody.safeParse({ ...run, run_id: "42" }).success).toBe(false);
	});

	it("数值字段的范围：轮次从 1 起，用量、时长、行数不为负", () => {
		const turnEnd = eventSamples.find((s) => s.name === "turn_end：completed")?.body;
		expect(SessionEventBody.safeParse({ ...turnEnd, turn: 0 }).success).toBe(false);
		expect(SessionEventBody.safeParse({ ...turnEnd, duration_ms: -1 }).success).toBe(false);
		expect(SessionEventBody.safeParse({ ...turnEnd, steps: 1.5 }).success).toBe(false);
		expect(
			SessionEventBody.safeParse({
				type: "assistant_message",
				text: "x",
				usage: { input: -1, output: 0, cache_read: 0, cache_write: 0 },
			}).success,
		).toBe(false);
		expect(
			SessionEventBody.safeParse({
				type: "assistant_message",
				text: "x",
				usage: { input: 1, output: 0, cache_read: 0 },
			}).success,
		).toBe(false);
		expect(
			SessionEventBody.safeParse({ type: "turn_queued", position: 0, waiting_for: {} }).success,
		).toBe(false);
		expect(
			SessionEvent.safeParse({ ...persistedStamp, seq: 0, type: "turn_started", turn: 1 }).success,
		).toBe(false);
		expect(
			SessionEvent.safeParse({ ...persistedStamp, at: "昨天", type: "turn_started", turn: 1 })
				.success,
		).toBe(false);
	});

	it("可以转成 JSON Schema（接口定义和生成客户端要用）", () => {
		for (const schema of [SessionEvent, SessionEventBody, SessionDetailResponse, SessionView]) {
			expect(() => toJsonSchema(schema)).not.toThrow();
		}
	});
});

describe("会话接口的类型", () => {
	it("状态和就绪问题的取值", () => {
		expect(SessionStatus.options).toEqual(["idle", "running", "queued", "ended"]);
		expect(ReadinessProblemKind.options).toEqual([
			"assistant_not_configured",
			"assistant_unreachable",
			"workbench_not_set",
			"workbench_offline",
			"model_not_configured",
			"model_unreachable",
		]);
		expect(SessionErrorCode.options).toEqual([
			"assistant_not_configured",
			"assistant_unavailable",
			"model_unavailable",
			"turn_running",
			"project_busy",
			"session_queued",
			"session_ended",
		]);
	});

	it("会话视图：列表项加项目和就绪状态；状态、排队位置、上一轮的结局", () => {
		const view = { ...listItem, project: "default", readiness: readyNow };
		expect(SessionView.parse(view)).toEqual(view);
		for (const status of SessionStatus.options) {
			expect(SessionView.safeParse({ ...view, status }).success).toBe(true);
		}
		expect(SessionView.safeParse({ ...view, status: "paused" }).success).toBe(false);
		expect(SessionView.safeParse({ ...view, status: "queued", queue_position: 2 }).success).toBe(
			true,
		);
		expect(SessionView.safeParse({ ...view, queue_position: 0 }).success).toBe(false);
		for (const outcome of TurnOutcome.options) {
			expect(SessionView.safeParse({ ...view, last_turn_outcome: outcome }).success).toBe(true);
		}
		expect(SessionView.safeParse({ ...view, last_turn_outcome: "crashed" }).success).toBe(false);
		expect(SessionView.safeParse({ ...view, id: "不是 UUID" }).success).toBe(false);
		const { project: _project, ...withoutProject } = view;
		expect(SessionView.safeParse(withoutProject).success).toBe(false);
		const { readiness: _readiness, ...withoutReadiness } = view;
		expect(SessionView.safeParse(withoutReadiness).success).toBe(false);
	});

	it("就绪状态：每种问题都能表达，问题要写一句话", () => {
		for (const kind of ReadinessProblemKind.options) {
			const readiness = { ready: false, problems: [{ kind, message: "…" }] };
			expect(SessionListResponse.safeParse({ readiness, sessions: [] }).success).toBe(true);
		}
		expect(
			SessionListResponse.safeParse({
				readiness: { ready: false, problems: [{ kind: "workbench_offline" }] },
				sessions: [],
			}).success,
		).toBe(false);
		expect(
			SessionListResponse.safeParse({
				readiness: { ready: false, problems: [{ kind: "disk_full", message: "…" }] },
				sessions: [],
			}).success,
		).toBe(false);
		expect(
			SessionListResponse.safeParse({ readiness: readyNow, sessions: [listItem] }).success,
		).toBe(true);
		expect(SessionListResponse.safeParse({ sessions: [listItem] }).success).toBe(false);
	});

	it("就绪状态：ready 当且仅当没有 problems", () => {
		const problem = { kind: "workbench_offline", message: "工作台不在线" };
		const check = (readiness: unknown) =>
			SessionListResponse.safeParse({ readiness, sessions: [] }).success;
		expect(check({ ready: true, problems: [] })).toBe(true);
		expect(check({ ready: false, problems: [problem] })).toBe(true);
		expect(check({ ready: true, problems: [problem] })).toBe(false);
		expect(check({ ready: false, problems: [] })).toBe(false);
	});

	it("新建会话和发话：只有 text，非空、不能只有空白、有长度上限", () => {
		for (const schema of [CreateSessionBody, SendMessageBody]) {
			expect(schema.parse({ text: "你好" })).toEqual({ text: "你好" });
			expect(schema.safeParse({ text: "" }).success).toBe(false);
			expect(schema.safeParse({ text: "  \n\t " }).success).toBe(false);
			expect(schema.safeParse({}).success).toBe(false);
			expect(schema.safeParse({ text: 3 }).success).toBe(false);
			expect(schema.safeParse({ text: "x".repeat(SESSION_MESSAGE_MAX_CHARS) }).success).toBe(true);
			expect(schema.safeParse({ text: "x".repeat(SESSION_MESSAGE_MAX_CHARS + 1) }).success).toBe(
				false,
			);
		}
	});

	it("会话详情：最多一页持久事件，不存的事件放不进去", () => {
		const view = { ...listItem, project: "default", readiness: readyNow };
		const event = { ...eventSamples[0]?.body, ...persistedStamp };
		expect(
			SessionDetailResponse.safeParse({ ...view, events: [event], has_more: false }).success,
		).toBe(true);
		expect(
			SessionDetailResponse.safeParse({
				...view,
				events: Array.from({ length: SESSION_HISTORY_PAGE }, () => event),
				has_more: true,
			}).success,
		).toBe(true);
		expect(
			SessionDetailResponse.safeParse({
				...view,
				events: Array.from({ length: SESSION_HISTORY_PAGE + 1 }, () => event),
				has_more: true,
			}).success,
		).toBe(false);
		expect(
			SessionDetailResponse.safeParse({
				...view,
				events: [{ type: "thinking" }],
				has_more: false,
			}).success,
		).toBe(false);
		expect(SessionDetailResponse.safeParse({ ...view, events: [] }).success).toBe(false);
	});

	it("查询参数：before 和 after 是序号，从查询字符串来所以接受数字字符串", () => {
		expect(SessionDetailQuery.parse({})).toEqual({});
		expect(SessionDetailQuery.parse({ before: "40" })).toEqual({ before: 40 });
		expect(SessionDetailQuery.safeParse({ before: "0" }).success).toBe(false);
		expect(SessionDetailQuery.safeParse({ before: "abc" }).success).toBe(false);
		expect(SessionEventsQuery.parse({ after: "0" })).toEqual({ after: 0 });
		expect(SessionEventsQuery.safeParse({ after: "-1" }).success).toBe(false);
		// 空字符串等于没给（和 http/actions.ts、http/run-list.ts 的查询参数一致）。
		expect(SessionDetailQuery.parse({ before: "" })).toEqual({});
		expect(SessionEventsQuery.parse({ after: "" })).toEqual({});
	});
});
