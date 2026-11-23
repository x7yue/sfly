import { randomUUID } from "node:crypto";
import {
	ASSISTANT_PROCESS_KILL_GRACE_MS,
	type AssistantErrorCode,
	type AssistantHealth,
	type PromptCommandBody,
	type Readiness,
	type ReadinessProblem,
	type SessionErrorCode,
	type SessionEventBody,
} from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { Actor } from "../actor.js";
import { agentEndpoint } from "../agents/agent-endpoint.js";
import type { AgentHub } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agents } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import {
	type AssistantClient,
	AssistantError,
	AssistantUnreachableError,
} from "./assistant-client.js";
import type { AssistantSetup } from "./assistant-config.js";
import { commandEnv } from "./command-env.js";
import {
	effectiveTurn,
	ProjectBusyError,
	type SessionRow,
	type SessionStore,
} from "./session-store.js";

/** 请求没有成功的原因：状态码、错误码（`SessionErrorCode`）和给人看的一句话。 */
export interface Rejection {
	status: 409 | 503;
	code: SessionErrorCode;
	message: string;
}

export type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Rejection);

const rejected = (status: 409 | 503, code: SessionErrorCode, message: string): Outcome<never> => ({
	ok: false,
	status,
	code,
	message,
});

/** 工作区在工作台上的路径。 */
const WORKDIR = "/work";

/** 会话的标题：第一句话的前 60 个字（空白压成一个空格）。 */
export const TITLE_CHARS = 60;
export function titleOf(text: string): string {
	return [...text.trim().replace(/\s+/g, " ")].slice(0, TITLE_CHARS).join("");
}

/**
 * 一个「在做」的会话多久没有持久事件，就当作这一轮中断了（毫秒）：一轮最长 20 分钟（#540），留出余量。
 * 控制面崩溃或重启、助手服务没有回话时，没有人会写这一轮的 `turn_end`，会话永远停在「在做」，
 * 这个项目就再也开不了新的一轮（同一个项目同一时刻只跑一轮）：这是兜底；断线之后的续传和助手服务重启之后的
 * 中断处理是 #545。
 */
export const STALE_TURN_MS = 30 * 60 * 1000;

/** 控制面等助手服务带回结局时，在它的强制结束宽限之外多留的余量（毫秒）：命令往返、进程退出之后发事件的时间。 */
export const STOP_MARGIN_MS = 3_000;

/**
 * 停止会话：把中止发给助手服务之后，最多等多久它把这一轮的结局（`turn_end`）带回来（毫秒）；超过由控制面结束这一轮。
 * **不短于助手服务停止一轮的宽限**（{@link ASSISTANT_PROCESS_KILL_GRACE_MS}：SIGTERM 之后这么久才 SIGKILL，结局在进程退出之后
 * 才发）加余量：短了的话，控制面先补一条 `stopped`、会话回到空闲，用户马上再说一句，助手服务那边上一轮还挂着，回 409
 * `turn_running`，新的一轮被记成失败。在做的会话点停止的响应最坏是「中止的命令超时 + 这个宽限」，平时助手服务很快带回结局，
 * 马上返回。
 */
export const STOP_GRACE_MS = ASSISTANT_PROCESS_KILL_GRACE_MS + STOP_MARGIN_MS;

/** 助手服务的 `/health` 结果缓存多久（毫秒）：每次列出会话都问一遍太频繁；同时来的请求共用一次（见 `#assistantHealth`）。 */
export const HEALTH_TTL_MS = 5_000;

/** `/health` 最多等多久（毫秒）：助手服务接了连接却不回话时，列出会话不能跟着卡 10 秒。 */
export const HEALTH_TIMEOUT_MS = 2_000;

export interface SessionServiceDeps {
	sessions: SessionStore;
	db: Db;
	hub: AgentHub;
	clock: Clock;
	setup: AssistantSetup;
	/** 助手配置好了才有。 */
	client: AssistantClient | undefined;
	/** 哪台 Agent 是工作台（Agent 的名字，`SFLY_WORKBENCH_AGENT`）；骨架期间由部署者配置，#549 换成项目上的一列。 */
	workbenchAgent: string | undefined;
	/** 停止之后等助手服务带回结局的宽限（毫秒），默认 {@link STOP_GRACE_MS}。 */
	stopGraceMs?: number;
	/**
	 * 助手服务出问题时写日志（连不上、拒绝、`/health` 不通……）：底层错误的原文（带着助手服务的地址和端口）只进这里，
	 * 回给请求的人和写进就绪状态、`turn_end` 的只有稳定的一句说明。
	 */
	log?: (message: string, error?: unknown) => void;
}

type WorkbenchTarget = PromptCommandBody["workbench"];

/**
 * 会话的写（建会话、发话、停止）和助手此刻能不能用：把一轮交给助手服务（`POST /sessions/:id/prompt`），
 * 助手没有配置时都返回 503 `assistant_not_configured`（读接口照常）。一个项目同一时刻只跑一轮：
 * 在做的会话在库里至多一个（唯一约束），冲突就拒绝，排队是 #544。
 *
 * 一轮开始时先写 `user_message` 和 `turn_started` 再交给助手服务：助手服务的事件可能在回应之前就到了，
 * 用户的话要排在它们前面。助手服务没接住：新建的会话删掉（不留下会话）；已有的会话补一条结局为失败的
 * `turn_end`（用户的话还在历史里，会话回到空闲，可以再说一次）。
 */
export class SessionService {
	#health: { at: number; result: { health: AssistantHealth } | { error: string } } | undefined;
	/** 正在问的那一次 `/health`：同时来的请求等它，不各问一遍。 */
	#healthAsking: Promise<{ health: AssistantHealth } | { error: string }> | undefined;

	constructor(private readonly deps: SessionServiceDeps) {}

	// ---- 就绪状态 ----

	/**
	 * 助手服务的 `/health`（缓存 {@link HEALTH_TTL_MS}，最多等 {@link HEALTH_TIMEOUT_MS}，同时来的请求共用一次）；
	 * 连不上时是原因。
	 */
	async #assistantHealth(): Promise<{ health: AssistantHealth } | { error: string }> {
		const { client, clock } = this.deps;
		if (!client) return { error: "助手没有配置" };
		const now = clock.now().getTime();
		if (this.#health && now - this.#health.at < HEALTH_TTL_MS) return this.#health.result;
		if (this.#healthAsking) return this.#healthAsking;
		const asking = (async () => {
			let result: { health: AssistantHealth } | { error: string };
			try {
				result = { health: await client.health(HEALTH_TIMEOUT_MS) };
			} catch (error) {
				this.deps.log?.("助手服务的 /health 没有正常回应", error);
				result = { error: publicMessage(error) };
			}
			this.#health = { at: now, result };
			return result;
		})().finally(() => {
			this.#healthAsking = undefined;
		});
		this.#healthAsking = asking;
		return asking;
	}

	/** 工作台：能用时是这一轮的目标（Agent 名、能力端口的地址、工作区路径），不能用时是原因。 */
	async #workbench(
		project: ProjectId,
	): Promise<{ target: WorkbenchTarget } | { problem: ReadinessProblem }> {
		const { workbenchAgent: name, hub, db } = this.deps;
		if (!name) {
			return {
				problem: {
					kind: "workbench_not_set",
					message: "没有设置工作台（SFLY_WORKBENCH_AGENT：哪台 Agent 是工作台）",
				},
			};
		}
		const [row] = await db
			.select({ projectId: agents.projectId })
			.from(agents)
			.where(eq(agents.name, name));
		if (row && row.projectId !== project) {
			return {
				problem: {
					kind: "workbench_not_set",
					message: `工作台 ${name} 不属于这个项目：设置的工作台要是这个项目里的 Agent`,
				},
			};
		}
		const connection = hub.connection(name);
		if (!connection) {
			return { problem: { kind: "workbench_offline", message: `工作台 ${name} 不在线` } };
		}
		const endpoint = agentEndpoint(connection.info);
		if (endpoint.port === null || endpoint.address === "") {
			return {
				problem: {
					kind: "workbench_offline",
					message: `工作台 ${name} 的能力端口不可用：${endpoint.unavailable_reason ?? "没有上报地址"}`,
				},
			};
		}
		const host = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
		return { target: { name, address: `${host}:${endpoint.port}`, workdir: WORKDIR } };
	}

	/**
	 * 助手此刻能不能用（每次列出会话时算一次）：没配地址或密钥、助手服务连不上（`/health` 不通）、没设置工作台、
	 * 工作台不在线，原因都列出来；`workbench` 是设置的工作台的名字。模型的两项是 #548。
	 */
	async readiness(project: ProjectId): Promise<Readiness> {
		const { setup } = this.deps;
		const problems: ReadinessProblem[] = [];
		if (!setup.configured) {
			problems.push({ kind: "assistant_not_configured", message: `助手没有开启：${setup.reason}` });
		} else {
			const health = await this.#assistantHealth();
			if ("error" in health) {
				problems.push({ kind: "assistant_unreachable", message: health.error });
			}
		}
		const workbench = await this.#workbench(project);
		if ("problem" in workbench) problems.push(workbench.problem);
		return {
			ready: problems.length === 0,
			problems,
			workbench: this.deps.workbenchAgent ?? null,
		};
	}

	// ---- 写 ----

	/** 写接口的前提：助手配置好了（没配是 503 `assistant_not_configured`）、有可用的工作台（没有是 503 `assistant_unavailable`）。 */
	async #ready(
		project: ProjectId,
	): Promise<Outcome<{ client: AssistantClient; target: WorkbenchTarget }>> {
		const { setup, client } = this.deps;
		if (!setup.configured || !client) {
			return rejected(
				503,
				"assistant_not_configured",
				`助手没有开启：${setup.configured ? "" : setup.reason}`,
			);
		}
		const workbench = await this.#workbench(project);
		if ("problem" in workbench) {
			return rejected(503, "assistant_unavailable", workbench.problem.message);
		}
		return { ok: true, value: { client, target: workbench.target } };
	}

	/**
	 * 新建会话：第一句话作为第一轮。建会话、写 `user_message`、写 `turn_started` 在一个事务里
	 * （{@link SessionStore.createWithTurn}），再把这一轮交给助手服务。
	 */
	async create(project: ProjectId, actor: Actor, text: string): Promise<Outcome<SessionRow>> {
		const { sessions } = this.deps;
		const ready = await this.#ready(project);
		if (!ready.ok) return ready;
		const busy = await sessions.running(project);
		if (busy) return projectBusy(busy);
		const messageId = randomUUID();
		let created: Awaited<ReturnType<SessionStore["createWithTurn"]>>;
		try {
			created = await sessions.createWithTurn(
				{
					project,
					title: titleOf(text),
					createdBy: actor.nickname,
					createdByUserId: actor.userId,
				},
				opening(messageId, actor, text),
			);
		} catch (error) {
			if (error instanceof ProjectBusyError) {
				const other = await sessions.running(project);
				return other ? projectBusy(other) : rejected(409, "project_busy", error.message);
			}
			throw error;
		}
		const { session } = created;
		const sent = await this.#handOver(session, 1, { messageId, text, actor }, ready.value);
		if (!sent.ok) {
			// 不留下会话。
			await sessions.delete(session.id);
			return sent;
		}
		return { ok: true, value: (await sessions.find(session.id)) ?? session };
	}

	/** 对会话说一句话：空闲时开始新的一轮，返回这句话的 `user_message` 的序号。 */
	async say(session: SessionRow, actor: Actor, text: string): Promise<Outcome<{ seq: number }>> {
		const ready = await this.#ready(session.projectId);
		if (!ready.ok) return ready;
		const messageId = randomUUID();
		const begun = await this.#begin(session, opening(messageId, actor, text));
		if (!begun.ok) return begun;
		const sent = await this.#handOver(
			session,
			begun.value.turn,
			{ messageId, text, actor },
			ready.value,
		);
		if (!sent.ok) return sent;
		return { ok: true, value: { seq: begun.value.seq } };
	}

	/**
	 * 空闲的会话开始一轮：`idle` → `running`、轮次加一、写 `user_message` 和 `turn_started`，在一个事务里
	 * （{@link SessionStore.beginTurn}）；其余状态和项目里有别的会话在做时拒绝。
	 */
	async #begin(
		session: SessionRow,
		events: (turn: number) => SessionEventBody[],
	): Promise<Outcome<{ turn: number; seq: number }>> {
		const { sessions } = this.deps;
		try {
			const result = await sessions.beginTurn(session.id, session.projectId, events);
			if (result.started) {
				return { ok: true, value: { turn: result.turn, seq: result.events[0]?.seq ?? 0 } };
			}
			switch (result.status) {
				case "ended":
					return rejected(409, "session_ended", "这个会话已经结束了，不再接受消息");
				case "queued":
					return rejected(409, "session_queued", "这个会话在排队，等轮到它");
				default:
					return rejected(409, "turn_running", "助手还在做上一轮，等它停下来再说");
			}
		} catch (error) {
			if (error instanceof ProjectBusyError) {
				const other = await sessions.running(session.projectId);
				return other ? projectBusy(other) : rejected(409, "project_busy", error.message);
			}
			throw error;
		}
	}

	/**
	 * 把这一轮交给助手服务（`user_message` 和 `turn_started` 已经落库）。没接住时补一条失败的结局（这一轮是会话此刻在做的
	 * 那一轮，会话回到空闲；新建的会话由调用方删掉）。**超时、连不上的结果是未知的**（助手服务可能已经收下了这一轮，
	 * 冷启动慢的时候就会这样）：尽力补发一次中止，让它别白做；这个窗口里助手服务发来的事件，会话已经不在做这一轮，
	 * 连接那边按「不是此刻在做的那一轮」丢掉。
	 */
	async #handOver(
		session: SessionRow,
		turn: number,
		message: { messageId: string; text: string; actor: Actor },
		ready: { client: AssistantClient; target: WorkbenchTarget },
	): Promise<Outcome<{ seq: number }>> {
		const { sessions } = this.deps;
		try {
			await ready.client.prompt(session.id, {
				turn,
				message_id: message.messageId,
				text: message.text,
				session: { title: session.title, created_by: session.createdBy },
				workbench: ready.target,
				...commandEnv(message.actor),
			});
		} catch (error) {
			this.deps.log?.(`助手服务没有接住会话 ${session.id} 的第 ${turn} 轮`, error);
			const failure = describeFailure(error);
			if (error instanceof AssistantUnreachableError) {
				// 带这一轮的轮次：助手服务那时还没登记这一轮的话，记下「这一轮已被中止」，它的 `prompt` 到了直接结束。
				ready.client.abort(session.id, turn).catch(() => {
					// 尽力而为：连不上就算了。
				});
			}
			await sessions.append(session.id, failureEnd(turn, failure));
			return rejected(failure.status, failure.code, failure.message);
		}
		return { ok: true, value: { seq: 0 } };
	}

	/**
	 * 兜底：在做的会话超过 {@link STALE_TURN_MS} 没有动静（按控制面自己的时钟记的 `last_activity_at`，助手服务的时钟偏了
	 * 也不影响），补一条结局为 `interrupted` 的 `turn_end`，会话回到空闲，项目才能再开始新的一轮。控制面启动时和之后
	 * 周期性地调用。返回补了几个。
	 */
	async expireStale(): Promise<number> {
		const { sessions, clock } = this.deps;
		const stale = await sessions.staleRunning(new Date(clock.now().getTime() - STALE_TURN_MS));
		for (const session of stale) {
			await this.#endTurn(
				session,
				effectiveTurn(session),
				"interrupted",
				"这一轮超过 30 分钟没有收到助手服务的消息，按中断处理（控制面或助手服务可能重启过）",
			);
		}
		return stale.length;
	}

	/**
	 * 停止会话正在做的这一轮：不在做时不改会话（助手没有配置时仍是 503，和别的写一样；空闲的会话仍向助手服务补发一次
	 * 带轮次的中止，见下面）；在做时先把这一轮的中止发给助手服务，
	 * 它会带回这一轮的 `turn_end`（等的时间 {@link STOP_GRACE_MS}，13 秒）；助手服务没有配置、连不上、不认识这一轮、
	 * 或者没有及时带回结局时，**由控制面自己补一条结局为 `stopped` 的 `turn_end`**，会话回到空闲：
	 * 助手服务不回话，用户也停得下来，项目不会因此一直开不了新的一轮。**结束的是「此刻在做的那一轮」**：停止一开始
	 * 就记下是第几轮，结束时按它核对（`SessionStore.append`）——这一轮已经结束、会话开始了下一轮，就不会把新的一轮结束掉。
	 * 助手服务晚到的同一轮的结局不再记（同一轮的 `turn_end` 只记一条）。
	 */
	async stop(session: SessionRow): Promise<Outcome<null>> {
		const { sessions, client } = this.deps;
		const current = (await sessions.find(session.id)) ?? session;
		if (current.status !== "running") {
			const configured = await this.#configured();
			if (!configured.ok) return configured;
			// 空闲的会话也向助手服务发一次中止（尽力而为，不等结果、不影响响应），**带最近的那一轮的轮次**：`prompt` 超时
			// 之后补发的中止如果没送到，这一轮可能照样在助手服务那边跑，而控制面这边会话是空闲的：用户再发话被拒绝（409），
			// 不发这一次，点停止也没有办法让它停下来。带轮次，助手服务只结束这一轮（已经结束的什么也不做），用户紧接着说
			// 一句话开始的新一轮不受影响。从没有过一轮的会话（`current_turn` 为 0）没有什么可结束的，不发。重复的中止无害。
			if (current.status === "idle" && current.currentTurn >= 1) {
				configured.value.abort(current.id, current.currentTurn).catch((error) => {
					this.deps.log?.(`给空闲的会话 ${current.id} 补发中止没有成功`, error);
				});
			}
			return { ok: true, value: null };
		}
		const turn = effectiveTurn(current);
		// 中止送到了，或者结果未知（命令超时、连接在发出请求之后断了：助手服务可能已经收下了、只是没来得及回应）：都要等助手服务
		// 带回结局；一定没送到（连接被拒绝、域名解析不了……）或者被拒绝才由控制面马上结束这一轮。
		let aborted = false;
		if (client) {
			try {
				await client.abort(current.id, turn);
				aborted = true;
			} catch (error) {
				aborted = error instanceof AssistantUnreachableError && error.outcomeUnknown;
				this.deps.log?.(
					aborted
						? `停止会话 ${current.id} 时中止的结果未知（可能已经送到助手服务），照样等它带回结局`
						: `停止会话 ${current.id} 时中止没有送到助手服务`,
					error,
				);
			}
		}
		if (aborted && (await this.#settled(current.id, turn))) return { ok: true, value: null };
		await this.#endTurn(
			current,
			turn,
			"stopped",
			aborted
				? "用户停止；助手服务没有及时带回这一轮的结局，由控制面结束"
				: "用户停止；助手服务没有回话（没有配置、连不上或不认识这一轮），由控制面结束",
		);
		return { ok: true, value: null };
	}

	/** 等第 `turn` 轮结束（会话离开「在做」，或已经在做下一轮），最多等宽限那么久；返回等到了没有。 */
	async #settled(sessionId: string, turn: number): Promise<boolean> {
		const deadline = Date.now() + (this.deps.stopGraceMs ?? STOP_GRACE_MS);
		for (;;) {
			const row = await this.deps.sessions.find(sessionId);
			if (!row || row.status !== "running" || effectiveTurn(row) !== turn) return true;
			const left = deadline - Date.now();
			if (left <= 0) return false;
			await new Promise((resolve) => setTimeout(resolve, Math.min(25, left)));
		}
	}

	/** 控制面自己结束第 `turn` 轮：补一条 `turn_end`（会话回到空闲和它在同一个事务里；这一轮已经有结局时也照样改回空闲）。 */
	async #endTurn(
		session: SessionRow,
		turn: number,
		outcome: "stopped" | "interrupted",
		reason: string,
	): Promise<void> {
		const { sessions, clock } = this.deps;
		await sessions.append(session.id, {
			type: "turn_end",
			turn,
			outcome,
			reason,
			duration_ms: Math.max(0, clock.now().getTime() - session.lastActivityAt.getTime()),
		});
	}

	async #configured(): Promise<Outcome<AssistantClient>> {
		const { setup, client } = this.deps;
		if (!setup.configured || !client) {
			return rejected(
				503,
				"assistant_not_configured",
				`助手没有开启：${setup.configured ? "" : setup.reason}`,
			);
		}
		return { ok: true, value: client };
	}
}

/** 一轮开头要写的事件：用户的话和这一轮的开始。 */
const opening =
	(messageId: string, actor: Actor, text: string) =>
	(turn: number): SessionEventBody[] => [
		{
			type: "user_message",
			message_id: messageId,
			text,
			steer: false,
			author: actor.nickname,
			author_user_id: actor.userId,
		},
		{ type: "turn_started", turn },
	];

const projectBusy = (running: SessionRow): Outcome<never> =>
	rejected(
		409,
		"project_busy",
		`这个项目里的会话「${running.title}」（${running.id}）正在做，同一个项目同一时刻只跑一轮，等它停下来`,
	);

interface Failure {
	status: 409 | 503;
	code: SessionErrorCode;
	message: string;
	/** `turn_end` 的结局：模型不可用，或者别的失败。 */
	outcome: "model_unavailable" | "failed";
}

/** 助手服务没接住这一轮：翻译成接口的错误码和这一轮的结局。 */
function describeFailure(error: unknown): Failure {
	if (error instanceof AssistantError) {
		// 说明是按错误码给的固定的一句（`AssistantError.message`），助手服务自己写的那句话只进日志。
		const code: AssistantErrorCode | undefined = error.code;
		if (code === "turn_running") {
			return { status: 409, code: "turn_running", message: error.message, outcome: "failed" };
		}
		if (code === "model_not_configured" || code === "model_unreachable") {
			return {
				status: 503,
				code: "model_unavailable",
				message: error.message,
				outcome: "model_unavailable",
			};
		}
		return {
			status: 503,
			code: "assistant_unavailable",
			message: error.message,
			outcome: "failed",
		};
	}
	return {
		status: 503,
		code: "assistant_unavailable",
		message: publicMessage(error),
		outcome: "failed",
	};
}

/**
 * 回给请求的人、写进就绪状态和 `turn_end` 的说明：连不上的一句（只有原因的种类，见 {@link AssistantUnreachableError}），
 * 别的意外错误只说「助手服务出错」，原文只进日志。
 */
function publicMessage(error: unknown): string {
	if (error instanceof AssistantUnreachableError || error instanceof AssistantError) {
		return error.message;
	}
	return "助手服务出错";
}

/** 控制面补的 `turn_end`：这一轮没有交到助手服务手上，没有工具调用和模型调用。 */
function failureEnd(turn: number, failure: Failure): SessionEventBody {
	return {
		type: "turn_end",
		turn,
		outcome: failure.outcome,
		reason: failure.message,
		steps: 0,
		model_calls: 0,
		duration_ms: 0,
		...(failure.outcome === "model_unavailable" && { error_class: "other" as const }),
	};
}
