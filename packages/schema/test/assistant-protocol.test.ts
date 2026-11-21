import { describe, expect, it } from "vitest";
import {
	ASSISTANT_SECRET_ENV,
	ASSISTANT_SECRET_MIN_LENGTH,
	AssistantErrorBody,
	AssistantErrorCode,
	AssistantEvent,
	AssistantEventsQuery,
	AssistantHealth,
	AssistantStreamLine,
	AssistantStreamRecord,
	PERSISTED_SESSION_EVENT_TYPES,
	PromptCommandBody,
	SESSION_MESSAGE_MAX_CHARS,
	SessionEventBody,
	SteerCommandBody,
} from "../src/index.js";
import { eventSamples } from "./support/session-event-samples.js";

const sessionId = "0c9d6b0a-2f4e-4a53-9e6b-7d1f3a5c8e21";
const prompt = {
	turn: 1,
	text: "给 http_check 加一个超时参数",
	workbench: {
		name: "workbench-default",
		address: "http://workbench:7000",
		workdir: "/work/default",
	},
	env: { SFLY_NICKNAME: "alice", AI_AGENT: "pi" },
};
const health = {
	epoch: "k3v9x2",
	versions: { assistant: "0.7.0", pi: "0.74.0" },
	model: {
		configured: true,
		reachable: true,
		checked_at: "2026-11-21T08:00:00.000Z",
		reason: null,
		error_class: null,
	},
	processes: { active: 2, limit: 8 },
};

describe("助手服务产生的事件（AssistantEvent）", () => {
	it("事件流里能出现的样例都能过，只有控制面产生的类型和种类都不能", () => {
		for (const sample of eventSamples) {
			expect(
				AssistantEvent.safeParse(sample.body).success,
				`${sample.name}：${sample.inAssistantStream ? "事件流里能出现的应该通过" : "不是助手服务产生的不应该出现在事件流里"}`,
			).toBe(sample.inAssistantStream);
		}
	});

	it("它是 SessionEventBody 的子集：每个通过的事件内容也通过 SessionEventBody", () => {
		for (const sample of eventSamples.filter((s) => s.inAssistantStream)) {
			expect(SessionEventBody.safeParse(AssistantEvent.parse(sample.body)).success).toBe(true);
		}
	});

	it("控制面才有的类型都有样例，而且都被拒绝：用户的话、一轮开始、排队、会话结束、快照", () => {
		const controlPlaneOnly = [
			"user_message",
			"turn_started",
			"turn_queued",
			"session_ended",
			"snapshot",
		];
		for (const type of controlPlaneOnly) {
			const samples = eventSamples.filter((s) => s.body.type === type);
			expect(samples.length, `${type} 没有样例`).toBeGreaterThan(0);
			for (const sample of samples) {
				expect(AssistantEvent.safeParse(sample.body).success, sample.name).toBe(false);
			}
		}
	});

	it("控制面才有的提示（queue_cancelled、events_lost）和平台记录（scenario_version、run）被拒绝，助手服务的提示和提交通过", () => {
		const notice = (kind: string) => ({ type: "notice", kind, message: "x" });
		for (const kind of ["queue_cancelled", "events_lost"]) {
			expect(AssistantEvent.safeParse(notice(kind)).success, kind).toBe(false);
		}
		for (const kind of ["retry", "retry_end", "compaction", "steer_dropped", "context_reset"]) {
			expect(AssistantEvent.safeParse(notice(kind)).success, kind).toBe(true);
		}
		const kinds = ["commit", "scenario_version", "run"];
		for (const kind of kinds) {
			const samples = eventSamples.filter(
				(s) => s.body.type === "platform" && s.body.kind === kind,
			);
			expect(samples.length, kind).toBe(1);
			expect(AssistantEvent.safeParse(samples[0]?.body).success, kind).toBe(kind === "commit");
		}
	});
});

describe("命令", () => {
	it("开始一轮：第几轮、话、工作台、环境变量", () => {
		expect(PromptCommandBody.parse(prompt)).toEqual(prompt);
		expect(PromptCommandBody.safeParse({ ...prompt, env: {} }).success).toBe(true);
	});

	it("开始一轮：缺字段、轮次不对、话为空或太长、工作台缺字段、环境变量名不合法都被拒绝", () => {
		for (const key of Object.keys(prompt)) {
			const without: Record<string, unknown> = { ...prompt };
			delete without[key];
			expect(PromptCommandBody.safeParse(without).success, `缺了 ${key}`).toBe(false);
		}
		expect(PromptCommandBody.safeParse({ ...prompt, turn: 0 }).success).toBe(false);
		expect(PromptCommandBody.safeParse({ ...prompt, text: " " }).success).toBe(false);
		expect(
			PromptCommandBody.safeParse({ ...prompt, text: "x".repeat(SESSION_MESSAGE_MAX_CHARS + 1) })
				.success,
		).toBe(false);
		for (const key of Object.keys(prompt.workbench)) {
			const workbench: Record<string, unknown> = { ...prompt.workbench };
			delete workbench[key];
			expect(
				PromptCommandBody.safeParse({ ...prompt, workbench }).success,
				`工作台缺了 ${key}`,
			).toBe(false);
		}
		expect(PromptCommandBody.safeParse({ ...prompt, env: { "1BAD": "x" } }).success).toBe(false);
		expect(PromptCommandBody.safeParse({ ...prompt, env: { "A B": "x" } }).success).toBe(false);
		expect(PromptCommandBody.safeParse({ ...prompt, env: { A: 1 } }).success).toBe(false);
	});

	it("插话：只有 text，非空", () => {
		expect(SteerCommandBody.parse({ text: "先别改测试" })).toEqual({ text: "先别改测试" });
		expect(SteerCommandBody.safeParse({ text: "" }).success).toBe(false);
		expect(SteerCommandBody.safeParse({}).success).toBe(false);
	});

	it("错误码和回应体", () => {
		expect(AssistantErrorCode.options).toEqual([
			"unauthorized",
			"invalid_request",
			"turn_running",
			"no_turn_running",
			"model_not_configured",
			"model_unreachable",
			"process_limit",
			"start_failed",
		]);
		expect(
			AssistantErrorBody.parse({ code: "turn_running", message: "这个会话已有一轮在做" }),
		).toEqual({
			code: "turn_running",
			message: "这个会话已有一轮在做",
		});
		expect(AssistantErrorBody.safeParse({ code: "teapot", message: "x" }).success).toBe(false);
		expect(AssistantErrorBody.safeParse({ code: "unauthorized" }).success).toBe(false);
	});

	it("共享密钥：环境变量名和最短长度", () => {
		expect(ASSISTANT_SECRET_ENV).toBe("SFLY_ASSISTANT_SECRET");
		expect(ASSISTANT_SECRET_MIN_LENGTH).toBe(32);
	});
});

describe("事件流", () => {
	const record = {
		epoch: "k3v9x2",
		seq: 12,
		session_id: sessionId,
		turn: 2,
		event: { type: "tool_call", call_id: "call_1", tool: "bash", title: "ls" },
	};

	it("第一行是 hello，之后是事件记录；两种都能认出来", () => {
		expect(AssistantStreamLine.parse({ type: "hello", epoch: "k3v9x2", gap: false })).toEqual({
			type: "hello",
			epoch: "k3v9x2",
			gap: false,
		});
		expect(AssistantStreamLine.parse(record)).toEqual(record);
		const { seq: _seq, ...transient } = {
			...record,
			event: { type: "assistant_delta", text: "我先" },
		};
		expect(AssistantStreamLine.parse(transient)).toEqual(transient);
	});

	it("事件记录：缺字段、轮次不对、会话 ID 不是 UUID、事件是控制面才有的类型都被拒绝", () => {
		for (const key of ["epoch", "session_id", "turn", "event"]) {
			const without: Record<string, unknown> = { ...record };
			delete without[key];
			expect(AssistantStreamRecord.safeParse(without).success, `缺了 ${key}`).toBe(false);
		}
		expect(AssistantStreamRecord.safeParse({ ...record, turn: 0 }).success).toBe(false);
		expect(AssistantStreamRecord.safeParse({ ...record, seq: 0 }).success).toBe(false);
		expect(AssistantStreamRecord.safeParse({ ...record, session_id: "../../etc" }).success).toBe(
			false,
		);
		expect(
			AssistantStreamRecord.safeParse({
				...record,
				event: { type: "user_message", text: "x", steer: false, author: "a", author_user_id: null },
			}).success,
		).toBe(false);
		expect(AssistantStreamLine.safeParse({ type: "hello", epoch: "k3v9x2" }).success).toBe(false);
		expect(
			AssistantStreamLine.safeParse({ type: "bye", epoch: "k3v9x2", gap: false }).success,
		).toBe(false);
	});

	it("seq 只有持久的事件有：持久的必须带，不持久的不能带", () => {
		const base = { epoch: "k3v9x2", session_id: sessionId, turn: 2 };
		for (const sample of eventSamples.filter((s) => s.inAssistantStream)) {
			const persisted = (PERSISTED_SESSION_EVENT_TYPES as readonly string[]).includes(
				sample.body.type,
			);
			const withSeq = { ...base, seq: 3, event: sample.body };
			const withoutSeq = { ...base, event: sample.body };
			expect(AssistantStreamRecord.safeParse(withSeq).success, `${sample.name} 带 seq`).toBe(
				persisted,
			);
			expect(AssistantStreamRecord.safeParse(withoutSeq).success, `${sample.name} 不带 seq`).toBe(
				!persisted,
			);
		}
	});

	it("续传的位置：<纪元>:<序号>", () => {
		expect(AssistantEventsQuery.parse({})).toEqual({});
		expect(AssistantEventsQuery.parse({ after: "k3v9x2:0" })).toEqual({ after: "k3v9x2:0" });
		expect(AssistantEventsQuery.parse({ after: "a-b_C:15" })).toEqual({ after: "a-b_C:15" });
		for (const bad of [
			"k3v9x2",
			"k3v9x2:",
			":3",
			"k3v9x2:-1",
			"k3v9x2:1.5",
			"a:b:3",
			"../x:1",
			"",
		]) {
			expect(AssistantEventsQuery.safeParse({ after: bad }).success, bad).toBe(false);
		}
	});
});

describe("健康检查", () => {
	it("纪元、版本、模型、进程数", () => {
		expect(AssistantHealth.parse(health)).toEqual(health);
		expect(
			AssistantHealth.safeParse({
				...health,
				model: {
					configured: false,
					reachable: null,
					checked_at: null,
					reason: null,
					error_class: null,
				},
				processes: { active: 0, limit: null },
			}).success,
		).toBe(true);
	});

	it("缺字段、模型的故障类别不认识、进程数为负都被拒绝", () => {
		for (const key of Object.keys(health)) {
			const without: Record<string, unknown> = { ...health };
			delete without[key];
			expect(AssistantHealth.safeParse(without).success, `缺了 ${key}`).toBe(false);
		}
		expect(
			AssistantHealth.safeParse({ ...health, model: { ...health.model, error_class: "gremlins" } })
				.success,
		).toBe(false);
		expect(
			AssistantHealth.safeParse({ ...health, processes: { active: -1, limit: 8 } }).success,
		).toBe(false);
	});
});
