import { describe, expect, it } from "vitest";
import {
	AbortCommandBody,
	ASSISTANT_ABORT_SETTLE_MS,
	ASSISTANT_PROCESS_KILL_GRACE_MS,
	ASSISTANT_SECRET_ENV,
	ASSISTANT_SECRET_MIN_LENGTH,
	ASSISTANT_STOP_MARGIN_MS,
	ASSISTANT_STOP_WAIT_MS,
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
const AT = "2026-11-21T08:00:05.000Z";
const prompt = {
	turn: 1,
	message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000001",
	text: "给 http_check 加一个超时参数",
	session: { title: "给 http_check 加超时", created_by: "alice" },
	workbench: {
		name: "workbench-default",
		address: "http://workbench:7000",
		workdir: "/work/default",
	},
	env: { SFLY_NICKNAME: "alice", AI_AGENT: "pi" },
	secret_env: { SFLY_API_TOKEN: "sfly_ses_0123456789abcdef" },
};
const health = {
	epoch: "k3v9x2",
	versions: { assistant: "0.7.0", pi: "0.74.0" },
	model: {
		configured: true,
		endpoint: { host: "models.internal", port: 8443 },
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

	it("没有送到的插话：steer_dropped 必须带这句话的 message_id（UUID），带上它的提示也是合法的会话事件", () => {
		const dropped = {
			type: "notice",
			kind: "steer_dropped",
			message: "这句插话没有送到助手：「先别改测试」",
			message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000002",
		};
		expect(AssistantEvent.parse(dropped)).toEqual(dropped);
		expect(SessionEventBody.parse(dropped)).toEqual(dropped);
		// 必带：助手服务那一半漏写时，解析失败（助手服务的事件、控制面的会话事件、读的一方看到的形状都是）。
		const { message_id: _id, ...bare } = dropped;
		expect(AssistantEvent.safeParse(bare).success).toBe(false);
		expect(SessionEventBody.safeParse(bare).success).toBe(false);
		expect(AssistantEvent.safeParse({ ...dropped, message_id: "m2" }).success).toBe(false);
		expect(AssistantEvent.safeParse({ ...dropped, message_id: 2 }).success).toBe(false);
		// 排队中的话被取消：控制面写，同样必须带 message_id，不是助手服务产生的。
		const cancelled = {
			type: "notice",
			kind: "queue_cancelled",
			message: "这句话排队时被取消了，没有交给助手",
			message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000005",
		};
		expect(SessionEventBody.parse(cancelled)).toEqual(cancelled);
		expect(AssistantEvent.safeParse(cancelled).success).toBe(false);
		const { message_id: _cid, ...cancelledBare } = cancelled;
		expect(SessionEventBody.safeParse(cancelledBare).success).toBe(false);
	});

	it("其他种类的提示不能带 message_id：retry、retry_end、compaction、context_reset、events_lost", () => {
		const id = "5d1c0a7e-3b2f-4c68-9a41-000000000002";
		for (const kind of ["retry", "retry_end", "compaction", "context_reset"]) {
			const bare = { type: "notice", kind, message: "x" };
			expect(AssistantEvent.safeParse(bare).success, kind).toBe(true);
			expect(AssistantEvent.safeParse({ ...bare, message_id: id }).success, kind).toBe(false);
			expect(SessionEventBody.safeParse({ ...bare, message_id: id }).success, kind).toBe(false);
		}
		const lost = { type: "notice", kind: "events_lost", message: "x" };
		expect(SessionEventBody.safeParse(lost).success).toBe(true);
		expect(SessionEventBody.safeParse({ ...lost, message_id: id }).success).toBe(false);
	});

	it("控制面才有的提示（queue_cancelled、events_lost）和平台记录（scenario_version、run）被拒绝，助手服务的提示和提交通过", () => {
		const id = "5d1c0a7e-3b2f-4c68-9a41-000000000002";
		const notice = (kind: string) => ({
			type: "notice",
			kind,
			message: "x",
			...(kind === "steer_dropped" || kind === "queue_cancelled" ? { message_id: id } : {}),
		});
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
	it("开始一轮：第几轮、这句话的 ID、话、会话的标题和发起人、工作台、普通和 secret 环境变量", () => {
		expect(PromptCommandBody.parse(prompt)).toEqual(prompt);
		expect(PromptCommandBody.safeParse({ ...prompt, env: {}, secret_env: {} }).success).toBe(true);
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
		expect(PromptCommandBody.safeParse({ ...prompt, message_id: "m1" }).success).toBe(false);
		for (const key of Object.keys(prompt.session)) {
			const session: Record<string, unknown> = { ...prompt.session };
			delete session[key];
			expect(PromptCommandBody.safeParse({ ...prompt, session }).success, `会话缺了 ${key}`).toBe(
				false,
			);
		}
		// 普通的和 secret 环境变量都按环境变量名和字符串值检查。
		for (const field of ["env", "secret_env"]) {
			expect(PromptCommandBody.safeParse({ ...prompt, [field]: { "1BAD": "x" } }).success).toBe(
				false,
			);
			expect(PromptCommandBody.safeParse({ ...prompt, [field]: { "A B": "x" } }).success).toBe(
				false,
			);
			expect(PromptCommandBody.safeParse({ ...prompt, [field]: { A: 1 } }).success).toBe(false);
		}
	});

	it("插话：对第几轮说的（整数、从 1 起）、这句话的 ID 和文字，文字非空", () => {
		const steer = {
			turn: 3,
			message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000002",
			text: "先别改测试",
		};
		expect(SteerCommandBody.parse(steer)).toEqual(steer);
		expect(SteerCommandBody.safeParse({ ...steer, text: "" }).success).toBe(false);
		expect(SteerCommandBody.safeParse({ turn: 3, text: "先别改测试" }).success).toBe(false);
		expect(SteerCommandBody.safeParse({ ...steer, message_id: "m2" }).success).toBe(false);
		// 轮次：缺了（迟到的插话会落进下一轮）、为 0、小数、不是数字都被拒绝。
		const { turn: _turn, ...withoutTurn } = steer;
		expect(SteerCommandBody.safeParse(withoutTurn).success).toBe(false);
		for (const turn of [0, -1, 1.5, "3", null]) {
			expect(SteerCommandBody.safeParse({ ...steer, turn }).success, String(turn)).toBe(false);
		}
		expect(SteerCommandBody.safeParse({}).success).toBe(false);
	});

	it("结束一轮（中止）：带要结束的轮次（整数、从 1 起）；缺了、为 0、小数、不是数字都被拒绝，多余的字段被去掉", () => {
		expect(AbortCommandBody.parse({ turn: 3 })).toEqual({ turn: 3 });
		expect(AbortCommandBody.parse({ turn: 1, extra: "x" })).toEqual({ turn: 1 });
		for (const bad of [
			{},
			{ turn: 0 },
			{ turn: -1 },
			{ turn: 1.5 },
			{ turn: "2" },
			{ turn: null },
		]) {
			expect(AbortCommandBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
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

	it("停止一轮的时间：等 abort 的 10 秒、结束进程的宽限 10 秒、余量 3 秒，合起来 23 秒（控制面等结局和助手服务等旧的一轮用同一个数）", () => {
		expect(ASSISTANT_ABORT_SETTLE_MS).toBe(10_000);
		expect(ASSISTANT_PROCESS_KILL_GRACE_MS).toBe(10_000);
		expect(ASSISTANT_STOP_MARGIN_MS).toBe(3_000);
		expect(ASSISTANT_STOP_WAIT_MS).toBe(23_000);
		// 最坏的一条路：pi 不理 abort（等满 ABORT_SETTLE），也不理 SIGTERM（等满宽限才 SIGKILL）；余量不能是零。
		expect(ASSISTANT_STOP_WAIT_MS).toBe(
			ASSISTANT_ABORT_SETTLE_MS + ASSISTANT_PROCESS_KILL_GRACE_MS + ASSISTANT_STOP_MARGIN_MS,
		);
		expect(ASSISTANT_STOP_MARGIN_MS).toBeGreaterThan(0);
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
		at: AT,
		event: { type: "tool_call", call_id: "call_1", tool: "command", title: "ls" },
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

	it("事件流里的 steer_dropped 要带 seq（持久）和 message_id（没有送到的那句话），缺了 message_id 被拒绝", () => {
		const dropped = {
			type: "notice",
			kind: "steer_dropped",
			message: "这句插话没有送到助手：「先别改测试」",
			message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000002",
		};
		expect(AssistantStreamRecord.safeParse({ ...record, event: dropped }).success).toBe(true);
		const { message_id: _id, ...bare } = dropped;
		expect(AssistantStreamRecord.safeParse({ ...record, event: bare }).success).toBe(false);
		const { seq: _seq, ...withoutSeq } = { ...record, event: dropped };
		expect(AssistantStreamRecord.safeParse(withoutSeq).success).toBe(false);
	});

	it("事件记录：缺字段、轮次不对、会话 ID 不是 UUID、事件是控制面才有的类型都被拒绝", () => {
		for (const key of ["epoch", "session_id", "turn", "at", "event"]) {
			const without: Record<string, unknown> = { ...record };
			delete without[key];
			expect(AssistantStreamRecord.safeParse(without).success, `缺了 ${key}`).toBe(false);
		}
		expect(AssistantStreamRecord.safeParse({ ...record, turn: 0 }).success).toBe(false);
		expect(AssistantStreamRecord.safeParse({ ...record, seq: 0 }).success).toBe(false);
		// at 是产生事件的时间（控制面原样存成持久事件的 at）：要是时间。
		expect(AssistantStreamRecord.safeParse({ ...record, at: "昨天" }).success).toBe(false);
		expect(AssistantStreamRecord.safeParse({ ...record, session_id: "../../etc" }).success).toBe(
			false,
		);
		expect(
			AssistantStreamRecord.safeParse({
				...record,
				event: {
					type: "user_message",
					message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000001",
					text: "x",
					steer: false,
					author: "a",
					author_user_id: null,
				},
			}).success,
		).toBe(false);
		expect(AssistantStreamLine.safeParse({ type: "hello", epoch: "k3v9x2" }).success).toBe(false);
		expect(
			AssistantStreamLine.safeParse({ type: "bye", epoch: "k3v9x2", gap: false }).success,
		).toBe(false);
	});

	it("seq 只有持久的事件有：持久的必须带，不持久的不能带", () => {
		const base = { epoch: "k3v9x2", session_id: sessionId, turn: 2, at: AT };
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
					endpoint: null,
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
