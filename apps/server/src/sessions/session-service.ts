import { randomUUID } from "node:crypto";
import type {
	AssistantErrorCode,
	AssistantHealth,
	PromptCommandBody,
	Readiness,
	ReadinessProblem,
	SessionErrorCode,
	SessionEventBody,
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
import { ProjectBusyError, type SessionRow, type SessionStore } from "./session-store.js";

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

/** 停止会话：把中止发给助手服务之后，最多等多久它把这一轮的结局（`turn_end`）带回来（毫秒）；超过由控制面结束这一轮。 */
export const STOP_GRACE_MS = 5_000;

/** 助手服务的 `/health` 结果缓存多久（毫秒）：每次列出会话都问一遍太频繁。 */
const HEALTH_TTL_MS = 30_000;

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

	constructor(private readonly deps: SessionServiceDeps) {}

	// ---- 就绪状态 ----

	/** 助手服务的 `/health`（缓存 30 秒）；连不上时是原因。 */
	async #assistantHealth(): Promise<{ health: AssistantHealth } | { error: string }> {
		const { client, clock } = this.deps;
		if (!client) return { error: "助手没有配置" };
		const now = clock.now().getTime();
		if (this.#health && now - this.#health.at < HEALTH_TTL_MS) return this.#health.result;
		let result: { health: AssistantHealth } | { error: string };
		try {
			result = { health: await client.health() };
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		this.#health = { at: now, result };
		return result;
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

	/** 新建会话：第一句话作为第一轮。 */
	async create(project: ProjectId, actor: Actor, text: string): Promise<Outcome<SessionRow>> {
		const { sessions } = this.deps;
		const ready = await this.#ready(project);
		if (!ready.ok) return ready;
		const busy = await sessions.running(project);
		if (busy) return projectBusy(busy);
		let session: SessionRow;
		try {
			session = await sessions.create({
				project,
				title: titleOf(text),
				status: "running",
				createdBy: actor.nickname,
				createdByUserId: actor.userId,
			});
		} catch (error) {
			if (error instanceof ProjectBusyError) {
				const other = await sessions.running(project);
				return other ? projectBusy(other) : rejected(409, "project_busy", error.message);
			}
			throw error;
		}
		const sent = await this.#startTurn(session, actor, text, ready.value);
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
		const begun = await this.#begin(session);
		if (!begun.ok) return begun;
		const sent = await this.#startTurn(session, actor, text, ready.value);
		if (!sent.ok) return sent;
		return { ok: true, value: { seq: sent.value.seq } };
	}

	/** 空闲的会话开始一轮（`idle` → `running`）；其余状态和项目里有别的会话在做时拒绝。 */
	async #begin(session: SessionRow): Promise<Outcome<null>> {
		const { sessions } = this.deps;
		try {
			const result = await sessions.beginTurn(session.id, session.projectId);
			if (result.started) return { ok: true, value: null };
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

	/** 写 `user_message` 和 `turn_started`，把这一轮交给助手服务。失败时的收尾见类的说明。 */
	async #startTurn(
		session: SessionRow,
		actor: Actor,
		text: string,
		ready: { client: AssistantClient; target: WorkbenchTarget },
	): Promise<Outcome<{ seq: number }>> {
		const { sessions } = this.deps;
		const messageId = randomUUID();
		const turn = (await sessions.turnCount(session.id)) + 1;
		const message = await sessions.append(session.id, {
			type: "user_message",
			message_id: messageId,
			text,
			steer: false,
			author: actor.nickname,
			author_user_id: actor.userId,
		});
		await sessions.append(session.id, { type: "turn_started", turn });
		try {
			await ready.client.prompt(session.id, {
				turn,
				message_id: messageId,
				text,
				session: { title: session.title, created_by: session.createdBy },
				workbench: ready.target,
				...commandEnv(actor),
			});
		} catch (error) {
			const failure = describeFailure(error);
			// 这一轮没有开始：补一条失败的结局，会话回到空闲（新建的会话由调用方删掉）。
			await sessions.append(session.id, failureEnd(turn, failure));
			return rejected(failure.status, failure.code, failure.message);
		}
		return { ok: true, value: { seq: message.seq } };
	}

	/**
	 * 兜底：在做的会话超过 {@link STALE_TURN_MS} 没有持久事件，补一条结局为 `interrupted` 的 `turn_end`，会话回到空闲，
	 * 项目才能再开始新的一轮。控制面启动时和之后周期性地调用。返回补了几个。
	 */
	async expireStale(): Promise<number> {
		const { sessions, clock } = this.deps;
		const stale = await sessions.staleRunning(new Date(clock.now().getTime() - STALE_TURN_MS));
		for (const session of stale) {
			await this.#endTurn(
				session,
				"interrupted",
				"这一轮超过 30 分钟没有收到助手服务的消息，按中断处理（控制面或助手服务可能重启过）",
			);
		}
		return stale.length;
	}

	/**
	 * 停止会话正在做的这一轮：不在做时什么也不做（助手没有配置时仍是 503，和别的写一样）；在做时先把中止发给助手服务，
	 * 它会带回这一轮的 `turn_end`（等一小会儿，{@link STOP_GRACE_MS}）；助手服务没有配置、连不上、不认识这一轮、
	 * 或者没有及时带回结局时，**由控制面自己补一条结局为 `stopped` 的 `turn_end`**，会话回到空闲：
	 * 助手服务不回话，用户也停得下来，项目不会因此一直开不了新的一轮。助手服务晚到的同一轮的结局不再记
	 * （`SessionStore.append`：同一轮的 `turn_end` 只记一条）。
	 */
	async stop(session: SessionRow): Promise<Outcome<null>> {
		const { sessions, client } = this.deps;
		const current = (await sessions.find(session.id)) ?? session;
		if (current.status !== "running") {
			const configured = await this.#configured();
			return configured.ok ? { ok: true, value: null } : configured;
		}
		let aborted = false;
		if (client) {
			try {
				await client.abort(current.id);
				aborted = true;
			} catch {
				// 连不上或被拒绝：下面由控制面结束这一轮。
			}
		}
		if (aborted && (await this.#settled(current.id))) return { ok: true, value: null };
		await this.#endTurn(
			current,
			"stopped",
			aborted
				? "用户停止；助手服务没有及时带回这一轮的结局，由控制面结束"
				: "用户停止；助手服务没有回话（没有配置、连不上或不认识这一轮），由控制面结束",
		);
		return { ok: true, value: null };
	}

	/** 等会话离开「在做」（助手服务带回了结局），最多等宽限那么久；返回等到了没有。 */
	async #settled(sessionId: string): Promise<boolean> {
		const deadline = Date.now() + (this.deps.stopGraceMs ?? STOP_GRACE_MS);
		for (;;) {
			const row = await this.deps.sessions.find(sessionId);
			if (!row || row.status !== "running") return true;
			const left = deadline - Date.now();
			if (left <= 0) return false;
			await new Promise((resolve) => setTimeout(resolve, Math.min(25, left)));
		}
	}

	/** 控制面自己结束一轮：补一条 `turn_end`（会话回到空闲和它在同一个事务里）。 */
	async #endTurn(
		session: SessionRow,
		outcome: "stopped" | "interrupted",
		reason: string,
	): Promise<void> {
		const { sessions, clock } = this.deps;
		await sessions.append(session.id, {
			type: "turn_end",
			turn: Math.max(1, await sessions.turnCount(session.id)),
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
		const why =
			code === "unauthorized"
				? "助手服务拒绝了共享密钥（两边的 SFLY_ASSISTANT_SECRET 不一致）"
				: error.message;
		return { status: 503, code: "assistant_unavailable", message: why, outcome: "failed" };
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		status: 503,
		code: "assistant_unavailable",
		message: error instanceof AssistantUnreachableError ? message : `助手服务出错：${message}`,
		outcome: "failed",
	};
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
