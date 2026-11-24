import { randomUUID } from "node:crypto";
import {
	ASSISTANT_STOP_WAIT_MS,
	type AssistantErrorCode,
	type AssistantHealth,
	type PromptCommandBody,
	type Readiness,
	type ReadinessProblem,
	type SessionErrorCode,
	type SessionEventBody,
	type SessionView,
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
import { effectiveTurn, type SessionRow, type SessionStore } from "./session-store.js";

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

/**
 * 停止一轮：从**第一次发出中止的那一刻**起，最多等多久助手服务把这一轮的结局（`turn_end`）带回来（毫秒）；到点还没有，
 * 由控制面结束这一轮。中止有没有得到 202 都一样：连不上、超时、5xx 的时候照样等到这个时间（助手服务那边这一轮可能还在做，
 * 没有结局不空出项目的位置），期间收到助手服务的 `turn_end` 就用它。**不短于助手服务停止一轮最晚的时间**
 * （协议里的 {@link ASSISTANT_STOP_WAIT_MS}，两边引用同一个数：先用 pi 的 `abort` 等 10 秒，不行才结束进程，SIGTERM 之后
 * 10 秒才 SIGKILL，结局在进程退出之后才发，再加余量）：短了的话，控制面先补一条 `stopped`、会话回到空闲，用户马上再说
 * 一句，助手服务那边上一轮还挂着。在做的会话点停止的响应最坏是这个时间，平时助手服务很快带回结局，马上返回。
 */
export const STOP_GRACE_MS = ASSISTANT_STOP_WAIT_MS;

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
	 * 会话结束（会话已经改成 `ended`、`session_ended` 已经写下）之后调用：会话令牌合入之后在这里吊销这个会话的令牌
	 * （#544 留好的接口，谁后合入谁接上）。尽力而为，抛的错只进日志，不影响结束。
	 */
	onEnded?: (session: SessionRow) => Promise<void>;
	/**
	 * 助手服务出问题时写日志（连不上、拒绝、`/health` 不通……）：底层错误的原文（带着助手服务的地址和端口）只进这里，
	 * 回给请求的人和写进就绪状态、`turn_end` 的只有稳定的一句说明。
	 */
	log?: (message: string, error?: unknown) => void;
}

type WorkbenchTarget = PromptCommandBody["workbench"];

/** 一轮的 `prompt` 还没有得到 202 时，这一轮留着的插话（按说的先后）。 */
interface HandOver {
	turn: number;
	held: Array<{ messageId: string; text: string }>;
}

/**
 * 会话的写（建会话、发话、停止、结束）和助手此刻能不能用：把一轮交给助手服务（`POST /sessions/:id/prompt`），
 * 助手没有配置时都返回 503 `assistant_not_configured`（读接口照常）。一个项目同一时刻只跑一轮：
 * 在做的会话在库里至多一个（唯一约束）；项目里有别的会话在做时，新的一轮排队（`queued`），在做的那一轮结束时控制面
 * 开始排队时间最早的那个（#544；排队只在控制面，助手服务不知道项目）。在做时发话是插话（`steer`）。
 *
 * 一轮开始时先写 `user_message` 和 `turn_started` 再交给助手服务：助手服务的事件可能在回应之前就到了，
 * 用户的话要排在它们前面。助手服务没接住：新建的会话删掉（不留下会话）；已有的会话补一条结局为失败的
 * `turn_end`（用户的话还在历史里，会话回到空闲，可以再说一次）。**`prompt` 的回应和插话一个口径**：助手服务明确拒绝（503 是
 * 登记之前就知道起不了，409、4xx 也是）、连接没建起来（被拒绝、域名解析不了）的，这一轮一定没有开始，马上补结局；别的 5xx、
 * 超时、连接在发出请求之后断了，这一轮可能已经开始，先补发带轮次的中止，等到助手服务带回结局或者到期
 * （{@link STOP_GRACE_MS}）再补，期间项目的位置不空出来（{@link SessionService.#handOver}）。
 */
export class SessionService {
	#health: { at: number; result: { health: AssistantHealth } | { error: string } } | undefined;
	/** 正在问的那一次 `/health`：同时来的请求等它，不各问一遍。 */
	#healthAsking: Promise<{ health: AssistantHealth } | { error: string }> | undefined;

	/** 后台在做的事（开始排队中的下一个会话）：关闭时等它们做完，测试也能等。 */
	readonly #background = new Set<Promise<unknown>>();

	/**
	 * **正在停止**的会话：控制面发出了这一轮的中止、结局（助手服务带回的，或者控制面自己补的）还没有写下，会话 → 这一轮的轮次。
	 * 这期间用户说的话是新的一轮的开头，不是插话：排在这一轮后面（{@link SessionStore.queueBehind}，协议「停止一轮」的控制面一侧）。
	 */
	readonly #stopping = new Map<string, number>();

	/**
	 * 这一轮的 `prompt` 还没有得到助手服务的 202 时，这一轮的插话先留在这里（会话 → 这一轮的轮次和留着的话）：协议「插话」：
	 * 控制面等 202 之后才转发插话，按说的先后；转发期间新来的也排在后面。`prompt` 失败时留着的话不转发，由控制面补结局时各写一条
	 * `steer_dropped`（{@link SessionStore.appendTurnEnd}）。
	 */
	readonly #handOvers = new Map<string, HandOver>();

	constructor(private readonly deps: SessionServiceDeps) {
		// 一轮结束、项目的位置空出来了：让排队的最早一个开始。不等它（交给助手服务最多等 10 秒），错误自己记日志。
		deps.sessions.onTurnEnd((project) => this.#later(() => this.#promote(project)));
	}

	/** 后台做一件事：不等、错误进日志；{@link idle} 等它们做完。 */
	#later(run: () => Promise<void>): void {
		const task = run()
			.catch((error) => this.deps.log?.("开始排队中的会话失败", error))
			.finally(() => this.#background.delete(task));
		this.#background.add(task);
	}

	/** 等后台的事做完（关闭控制面之前；测试里等排队的会话开始）。 */
	async idle(): Promise<void> {
		while (this.#background.size > 0) await Promise.all([...this.#background]);
	}

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
	 * （{@link SessionStore.createWithTurn}），再把这一轮交给助手服务。项目里有别的会话在做（或在排队）时，这个会话排队
	 * （`queued`）：这句话照常写 `user_message`，不交给助手服务，轮到它时才交（{@link SessionService.#promote}）。
	 */
	async create(project: ProjectId, actor: Actor, text: string): Promise<Outcome<SessionRow>> {
		const { sessions } = this.deps;
		const ready = await this.#ready(project);
		if (!ready.ok) return ready;
		const messageId = randomUUID();
		const created = await sessions.createWithTurn(
			{
				project,
				title: titleOf(text),
				createdBy: actor.nickname,
				createdByUserId: actor.userId,
			},
			userMessage(messageId, actor, text),
		);
		const { session } = created;
		if (created.queued) {
			await this.#announceQueue(project);
			return { ok: true, value: (await sessions.find(session.id)) ?? session };
		}
		// 没接住：不留下会话（这一轮的结局写下之后删掉；结果未知的话等到结局写下才删，那之前项目的位置不空出来）。
		const sent = await this.#handOver(session, 1, { messageId, text, actor }, ready.value, () =>
			sessions.delete(session.id),
		);
		if (!sent.ok) return sent;
		return { ok: true, value: (await sessions.find(session.id)) ?? session };
	}

	/**
	 * 对会话说一句话，返回这句话的 `user_message` 的序号：
	 * - **在做**：插话（`steer: true`，{@link SessionService.#steer}），交给助手服务的 `steer`；**正在停止**（控制面发出了中止、
	 *   这一轮的结局还没有写下）时不是插话，是新的一轮的开头，排在这一轮后面（{@link SessionStore.queueBehind}，按说话的时刻排、
	 *   不插队），这一轮的结局写下之后由排队开始它；
	 * - **空闲**：开始新的一轮；项目里有别的会话在做（或在排队）时，这个会话排队，这句话轮到它时才交给助手服务；
	 * - **排队中** 409 `session_queued`，**已结束** 409 `session_ended`。
	 * 状态在两次读之间变了（比如刚读到在做、插话之前这一轮结束了）就按新的状态再来一次，最多三次。
	 */
	async say(session: SessionRow, actor: Actor, text: string): Promise<Outcome<{ seq: number }>> {
		const { sessions } = this.deps;
		const configured = await this.#configured();
		if (!configured.ok) return configured;
		for (let attempt = 0; attempt < 3; attempt++) {
			const current = (await sessions.find(session.id)) ?? session;
			if (current.status === "running") {
				// 正在停止（控制面发出了中止、结局还没有写下）：这句话是新的一轮的开头，排在这一轮后面，不是插话。在做、却有排队时间的会话
				// 只能是正在停止、已经有话排在后面的（控制面重启之后内存里的标记没了，这个判断仍然成立）。
				if (
					current.queuedAt !== null ||
					this.#stopping.get(current.id) === effectiveTurn(current)
				) {
					const behind = await sessions.queueBehind(
						current.id,
						userMessage(randomUUID(), actor, text),
					);
					if (behind.queued) {
						await this.#announceQueue(current.projectId);
						return { ok: true, value: { seq: behind.event.seq } };
					}
					if (behind.already) {
						return rejected(409, "session_queued", "这个会话在排队，等开始之后再说，或者先停止");
					}
					continue;
				}
				const steered = await this.#steer(current, actor, text, configured.value);
				if (steered !== "retry") return steered;
				continue;
			}
			const ready = await this.#ready(session.projectId);
			if (!ready.ok) return ready;
			const messageId = randomUUID();
			const begun = await sessions.beginTurn(
				session.id,
				session.projectId,
				userMessage(messageId, actor, text),
			);
			switch (begun.outcome) {
				case "started": {
					const sent = await this.#handOver(
						session,
						begun.turn,
						{ messageId, text, actor },
						ready.value,
					);
					if (!sent.ok) return sent;
					return { ok: true, value: { seq: begun.events[0]?.seq ?? 0 } };
				}
				case "queued":
					await this.#announceQueue(session.projectId);
					return { ok: true, value: { seq: begun.events[0]?.seq ?? 0 } };
				case "refused":
					if (begun.status === "running") continue;
					if (begun.status === "ended") {
						return rejected(409, "session_ended", "这个会话已经结束了，不再接受消息");
					}
					return rejected(409, "session_queued", "这个会话在排队，等开始之后再说，或者先停止");
			}
		}
		return rejected(409, "turn_running", "会话的状态一直在变，稍后再说一次");
	}

	/**
	 * 在做的会话里插话：写 `user_message`（`steer: true`，在一个事务里核对会话此刻在做），再交给助手服务的 `steer`
	 * （协议见 `SteerCommandBody`）。**这一轮的 `prompt` 还没有得到 202 时先留着**（{@link SessionService.#handOvers}），202
	 * 之后按说的先后转发。助手服务回 409 `no_turn_running`（这一轮刚好结束、在停止、助手服务重启过）时，这句话没有送到：为它写
	 * 一条 `steer_dropped` 的提示（带这句话的 `message_id`），不重试，也不当作新的一轮；这句话已经记在时间线上，响应照常返回它的
	 * 序号，用户看到提示可以再说一次。超时、连不上、5xx 也写提示（结果未知），响应是 503。**这一轮已经有 `turn_end` 的不写**
	 * （{@link SessionStore.appendSteerDropped}）。这一刻已经不在做了返回 `"retry"`，调用方按空闲的会话处理。
	 */
	async #steer(
		session: SessionRow,
		actor: Actor,
		text: string,
		client: AssistantClient,
	): Promise<Outcome<{ seq: number }> | "retry"> {
		const { sessions } = this.deps;
		const messageId = randomUUID();
		const steered = await sessions.steer(session.id, userMessage(messageId, actor, text, true));
		if (!steered.steered) return "retry";
		const seq = steered.event.seq;
		const gate = this.#handOvers.get(session.id);
		if (gate && gate.turn === steered.turn) {
			gate.held.push({ messageId, text });
			return { ok: true, value: { seq } };
		}
		const sent = await this.#sendSteer(session.id, steered.turn, messageId, text, client);
		if (sent.ok || sent.noTurn) return { ok: true, value: { seq } };
		const failure = describeFailure(sent.error);
		return rejected(failure.status, failure.code, failure.message);
	}

	/** 把一句插话交给助手服务；没有送到时为它写 `steer_dropped`（这一轮已经有结局的不写）。 */
	async #sendSteer(
		sessionId: string,
		turn: number,
		messageId: string,
		text: string,
		client: AssistantClient,
	): Promise<{ ok: true } | { ok: false; error: unknown; noTurn: boolean }> {
		try {
			await client.steer(sessionId, { turn, message_id: messageId, text });
			return { ok: true };
		} catch (error) {
			this.deps.log?.(`会话 ${sessionId} 的插话没有送到助手服务`, error);
			const noTurn = error instanceof AssistantError && error.code === "no_turn_running";
			// 协议「插话」：409 写「没有送到」；超时、连不上、5xx 之类结果未知（助手服务可能已经收下了），写「没有确认送到」。
			await this.deps.sessions.appendSteerDropped(
				sessionId,
				turn,
				messageId,
				noTurn
					? "这句插话没有送到：这一轮刚好结束了（或者正在停止），需要的话再说一次"
					: "这句插话没有确认送到助手（助手服务没有及时回应或者出错了），需要的话再说一次",
			);
			return { ok: false, error, noTurn };
		}
	}

	/**
	 * 排队中的会话轮到它了（项目里在做的那一轮结束、控制面启动时和每分钟的兜底）：开始排队时间最早的那个会话
	 * （{@link SessionStore.promoteNext}：`queued` → `running`、写 `turn_started`），把它排队时说的那句话交给助手服务；
	 * 剩下的排队的位置前进了，各推一条 `turn_queued`。交给助手服务没接住的话，这一轮以失败结束（`turn_end` 又会让下一个
	 * 开始）。没有排队的、项目里有会话在做、助手服务和工作台此刻不能用时什么也不做（排队的留在队里，兜底的扫描再来）；
	 * 重复调用无害。
	 */
	async #promote(project: ProjectId): Promise<void> {
		const { sessions } = this.deps;
		// 助手服务或工作台此刻不能用（控制面刚重启、工作台的 Agent 还没重新连上）：排队的留在队里，不把它们的话一个个失败掉；
		// 兜底的扫描（每分钟）会再来。
		const ready = await this.#ready(project);
		if (!ready.ok) {
			this.deps.log?.(`项目 ${project} 里排队的会话先不开始：${ready.message}`);
			return;
		}
		const promoted = await sessions.promoteNext(project);
		if (!promoted) return;
		await this.#announceQueue(project);
		const { session, turn, message } = promoted;
		const actor: Actor = {
			nickname: message.author,
			via: null,
			userId: message.author_user_id,
			token: null,
			sessionId: null,
		};
		// 没接住时 `#handOver` 自己补了失败的结局（让下一个排队的开始）。
		await this.#handOver(
			session,
			turn,
			{ messageId: message.message_id, text: message.text, actor },
			ready.value,
		);
	}

	/**
	 * 兜底：有会话排队、项目里却没有会话在做的（控制面重启、开始它的那一次没做完），开始排队最早的那个。控制面启动时和
	 * 每分钟（`expireStale` 之后）调用。返回开始了几个项目的。
	 */
	async startWaiting(): Promise<number> {
		const projects = await this.deps.sessions.projectsWaitingForTurn();
		for (const project of projects) this.#later(() => this.#promote(project));
		return projects.length;
	}

	/**
	 * 给项目里每个排队的会话推一条 `turn_queued`（不持久）：排第几、在等哪个会话和它的发起人。「排队的」包括排队中的，和停止途中说了话、
	 * 排在这一轮后面的在做的会话（{@link SessionStore.queueOrder}，按说话的时刻排）。队列变化时调用（有会话排上队、有会话被停止或
	 * 结束、排队的开始了）。没有会话在做时不推：它们在等开始，开始那一刻再推。
	 */
	async #announceQueue(project: ProjectId): Promise<void> {
		const { sessions } = this.deps;
		const queued = await sessions.queueOrder(project);
		if (queued.length === 0) return;
		const running = await sessions.running(project);
		if (!running) return;
		const waitingFor = {
			session_id: running.id,
			title: running.title,
			created_by: running.createdBy,
		};
		for (const [index, row] of queued.entries()) {
			sessions.publish(row.id, {
				type: "turn_queued",
				position: index + 1,
				waiting_for: waitingFor,
			});
		}
	}

	/**
	 * 排队的会话排第几和在等谁（接口的会话视图用）；没有排队时都是 null。「排队的」见 {@link SessionService.#announceQueue}：停止途中
	 * 说了话的在做的会话也有名次（在等的是它自己正在停止的这一轮）。
	 */
	async queueInfo(
		row: SessionRow,
	): Promise<{ position: number | null; waitingFor: SessionView["waiting_for"] }> {
		if (row.queuedAt === null) return { position: null, waitingFor: null };
		const { sessions } = this.deps;
		const running = await sessions.running(row.projectId);
		return {
			position: await sessions.queuePosition(row),
			waitingFor: running
				? { session_id: running.id, title: running.title, created_by: running.createdBy }
				: null,
		};
	}

	/**
	 * 把这一轮交给助手服务（`user_message` 和 `turn_started` 已经落库）。**交出去的期间这一轮的插话先留着**
	 * （{@link SessionService.#handOvers}）：拿到 202 之后按说的先后转发；没有得到 202 时留着的话不转发，各写一条 `steer_dropped`
	 * （协议「插话」）。没接住时按助手服务的回应分两种（`prompt` 的回应和插话一个口径）：
	 * - **这一轮一定没有开始**：助手服务明确拒绝（503 是登记之前就知道起不了；409、4xx 也是明确的拒绝），或者连接没建起来
	 *   （被拒绝、域名解析不了）：马上补一条失败的结局，会话回到空闲；
	 * - **结果未知**：别的 5xx、超时、连接在发出请求之后断了（助手服务可能已经收下了这一轮，冷启动慢的时候就会这样）：标成正在停止
	 *   （这期间用户说的话是新的一轮的开头，排在后面），**在后台**补发带这一轮轮次的中止（助手服务那时还没登记这一轮的话，记下这一轮
	 *   已被中止，它的 `prompt` 到了直接结束），等到助手服务带回结局或者到期（{@link STOP_GRACE_MS}，从发出中止起算），到期才补
	 *   结局；这之前项目的位置不空出来（助手服务那边这一轮其实还在做的话，同一个工作台上不会有两轮）。响应不等这些，照常是失败的说明。
	 * 这一轮的结局写下之后调用 `afterFailure`（新建的会话在这里删掉）。这个窗口里助手服务发来的事件：这一轮还在做时照常记，
	 * 已经不在做时连接那边按「不是此刻在做的那一轮」丢掉。
	 */
	async #handOver(
		session: SessionRow,
		turn: number,
		message: { messageId: string; text: string; actor: Actor },
		ready: { client: AssistantClient; target: WorkbenchTarget },
		afterFailure?: () => Promise<void>,
	): Promise<Outcome<{ seq: number }>> {
		const { sessions } = this.deps;
		const gate: HandOver = { turn, held: [] };
		this.#handOvers.set(session.id, gate);
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
			// 下面三步是同步的，中间没有别的请求插进来：摘下留着插话的地方（之后新来的插话直接转发）、取走已经留着的、结果未知的标成正在停止。
			if (this.#handOvers.get(session.id) === gate) this.#handOvers.delete(session.id);
			const held = gate.held.splice(0);
			const unknown = promptMayHaveStarted(error);
			if (unknown) this.#markStopping(session.id, turn);
			this.deps.log?.(`助手服务没有接住会话 ${session.id} 的第 ${turn} 轮`, error);
			const failure = describeFailure(error);
			for (const item of held) {
				await sessions.appendSteerDropped(
					session.id,
					turn,
					item.messageId,
					unknown
						? "这句插话没有确认送到助手（这一轮交给助手服务时没有得到确认），需要的话再说一次"
						: "这句插话没有送到（这一轮没有交到助手服务手上），需要的话再说一次",
				);
			}
			if (!unknown) {
				await sessions.appendTurnEnd(session.id, failureEnd(turn, failure));
				await afterFailure?.();
				return rejected(failure.status, failure.code, failure.message);
			}
			this.#later(async () => {
				await this.#abortAndSettle(session.id, turn, ready.client, () =>
					sessions.appendTurnEnd(session.id, failureEnd(turn, failure)),
				);
				await afterFailure?.();
			});
			return rejected(failure.status, failure.code, failure.message);
		}
		// 202：留着的插话按说的先后转发；转发期间新来的接在后面（`#steer` 看到还有留着插话的地方，就排进去），排空的那一刻同步地摘下。
		for (let next = gate.held.shift(); next; next = gate.held.shift()) {
			await this.#sendSteer(session.id, turn, next.messageId, next.text, ready.client);
		}
		if (this.#handOvers.get(session.id) === gate) this.#handOvers.delete(session.id);
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
	 * 停止会话：
	 * - **排队中**：移出队列、回到空闲，给排队时说的那句话写一条 `queue_cancelled` 的提示（{@link SessionStore.cancelQueued}），
	 *   后面的会话的位置随之更新（各推一条 `turn_queued`）；不需要助手服务；
	 * - **空闲、已结束**：不改会话（助手没有配置时仍是 503，和别的写一样）；空闲的会话仍向助手服务补发一次带轮次的中止，
	 *   见下面；
	 * - **在做**：{@link SessionService.#abortAndSettle}：标成正在停止（这期间用户说的话是新的一轮的开头，排在这一轮后面，
	 *   不是插话），把这一轮的中止发给助手服务，它会带回这一轮的 `turn_end`；等的时间 {@link STOP_GRACE_MS}（23 秒）**从发出中止的
	 *   那一刻起算**，中止没有得到 202（连不上、超时、5xx）也一样等到这个时间，期间收到 `turn_end` 就用它；到期还没有，**由控制面
	 *   自己补一条结局为 `stopped` 的 `turn_end`**（之前为这一轮里没有确认送到的插话各补一条 `steer_dropped`，
	 *   {@link SessionStore.appendTurnEnd}），会话回到空闲（有话排在后面的回到排队中）：助手服务不回话，用户也停得下来，项目不会因此一直
	 *   开不了新的一轮。助手没有配置时没有谁会带回结局，马上补。**结束的是「此刻在做的那一轮」**：停止一开始就记下是第几轮，结束时按它核对
	 *   （`SessionStore.append`）——这一轮已经结束、会话开始了下一轮，就不会把新的一轮结束掉。助手服务晚到的同一轮的结局不再记
	 *   （同一轮的 `turn_end` 只记一条）。这一轮结束时项目的位置空出来，排队的最早一个开始（`SessionStore.onTurnEnd`）。
	 */
	async stop(session: SessionRow): Promise<Outcome<null>> {
		const { sessions, client } = this.deps;
		const current = (await sessions.find(session.id)) ?? session;
		if (current.status === "queued") {
			const cancelled = await sessions.cancelQueued(current.id);
			if (cancelled.cancelled) await this.#announceQueue(current.projectId);
			return { ok: true, value: null };
		}
		if (current.status !== "running") {
			const configured = await this.#configured();
			if (!configured.ok) return configured;
			// 空闲的会话也向助手服务发一次中止（尽力而为，不等结果、不影响响应），**带最近的那一轮的轮次**：`prompt` 超时
			// 之后补发的中止如果没送到，这一轮可能照样在助手服务那边跑，而控制面这边会话是空闲的：用户再发话被拒绝（409），
			// 不发这一次，点停止也没有办法让它停下来。带轮次，助手服务只结束这一轮（控制面这边它已经结束；助手服务那边还在做的话
			// 照表停下，这正是这一次中止的用意），用户紧接着说一句话开始的新一轮不受影响。从没有过一轮的会话（`current_turn` 为 0）
			// 没有什么可结束的，不发。重复的中止无害。
			if (current.status === "idle" && current.currentTurn >= 1) {
				configured.value.abort(current.id, current.currentTurn).catch((error) => {
					this.deps.log?.(`给空闲的会话 ${current.id} 补发中止没有成功`, error);
				});
			}
			return { ok: true, value: null };
		}
		const turn = effectiveTurn(current);
		await this.#abortAndSettle(current.id, turn, client, () =>
			this.#endTurn(
				current,
				turn,
				"stopped",
				client
					? "用户停止；助手服务没有及时带回这一轮的结局（中止没有送到或者助手服务没有回话），由控制面结束"
					: "用户停止；助手没有配置，没有谁会带回这一轮的结局，由控制面结束",
			),
		);
		return { ok: true, value: null };
	}

	/**
	 * 结束会话：之后不再接受消息（409 `session_ended`），工作区、提交、场景版本、运行都留着，不删除任何东西。
	 * 协议「结束会话」的先后：在做的一轮先停止（{@link SessionService.stop}，**等到这一轮的结局**），排队的移出队列
	 * （`queue_cancelled`）；然后**写 `session_ended`**（会话改成 `ended`，和「此刻没有一轮在做、没有在排队」的核对在一个事务里，
	 * {@link SessionStore.end}），**写下之后**才把 `end` 发给助手服务（它结束这个会话的进程；尽力而为：连不上时会话照样已经结束，
	 * 进程由助手服务自己回收，#545）。写下之后控制面不再为这个会话发 `prompt` 和 `steer`：助手服务不记得会话结束了，`end` 之后来的
	 * `prompt` 它会照常做，所以先写下结束、再发 `end`，中间不会有新的一轮开始。已经结束的再调用无害（什么也不写）。
	 * 助手没有配置时 503（和别的写一样）。结束之后调用 `onEnded`（会话令牌合入之后在那里吊销，先于 `end` 的命令：不等助手服务）。
	 * 停止到写下 `session_ended` 之间会话又开始了一轮（别人刚好说了话）就再停一次，最多三次，还不行是 409 `turn_running`。
	 */
	async end(session: SessionRow, actor: Actor): Promise<Outcome<null>> {
		const { sessions } = this.deps;
		const configured = await this.#configured();
		if (!configured.ok) return configured;
		for (let attempt = 0; attempt < 3; attempt++) {
			const current = (await sessions.find(session.id)) ?? session;
			if (current.status === "ended") return { ok: true, value: null };
			if (current.status === "running") {
				await this.stop(current);
				continue;
			}
			if (current.status === "queued") {
				const cancelled = await sessions.cancelQueued(current.id);
				if (cancelled.cancelled) await this.#announceQueue(current.projectId);
				continue;
			}
			const ended = await sessions.end(current.id, actor.nickname);
			if (!ended.ended) continue;
			try {
				await this.deps.onEnded?.(current);
			} catch (error) {
				this.deps.log?.(`会话 ${current.id} 结束之后的收尾失败`, error);
			}
			// `session_ended` 已经写下，再发 `end`：收到就回 202，尽力而为（连不上时会话照样已经结束，进程由助手服务自己回收，#545）。
			try {
				await configured.value.end(current.id);
			} catch (error) {
				this.deps.log?.(`会话 ${current.id} 已经结束，但没能通知助手服务结束它的进程`, error);
			}
			return { ok: true, value: null };
		}
		return rejected(409, "turn_running", "会话又开始了一轮，先停止再结束");
	}

	/**
	 * 标记第 `turn` 轮正在停止。轮次只增：这个会话已经标着更大的轮次（更早一轮的收尾晚到、这个会话已经在停止更新的一轮）时留着更大的，
	 * 摘标记时只摘自己那一轮的（{@link SessionService.#abortAndSettle}）。
	 */
	#markStopping(sessionId: string, turn: number): void {
		this.#stopping.set(sessionId, Math.max(this.#stopping.get(sessionId) ?? 0, turn));
	}

	/**
	 * 停止第 `turn` 轮并等到它的结局（协议「停止一轮」的控制面一侧）：标成**正在停止**（到这一轮的结局写下为止，用户说的话是新的一轮的
	 * 开头，排在这一轮后面，不是插话），把带轮次的中止发给助手服务，从**发出中止的那一刻**起最多等 {@link STOP_GRACE_MS}：助手服务带回结局
	 * （或者这一轮已经不在做了）就返回 true；中止没有得到 202（连不上、超时、5xx）也一样等到这个时间，不马上补；到期还没有结局，调用
	 * `supply` 由控制面补，返回 false。**结局写下之后才摘掉正在停止的标记**，项目的位置也是那时才空出来。没有 `client`（助手没有配置）
	 * 时没有谁会带回结局，马上补。
	 */
	async #abortAndSettle(
		sessionId: string,
		turn: number,
		client: AssistantClient | undefined,
		supply: () => Promise<unknown>,
	): Promise<boolean> {
		this.#markStopping(sessionId, turn);
		try {
			if (client) {
				const sentAt = Date.now();
				try {
					await client.abort(sessionId, turn);
				} catch (error) {
					this.deps.log?.(
						`会话 ${sessionId} 的第 ${turn} 轮发出的中止没有得到确认，照样等到期限，再由控制面补结局`,
						error,
					);
				}
				if (await this.#settled(sessionId, turn, sentAt)) return true;
			}
			await supply();
			return false;
		} finally {
			if (this.#stopping.get(sessionId) === turn) this.#stopping.delete(sessionId);
		}
	}

	/**
	 * 等第 `turn` 轮结束（会话离开「在做」，或已经在做下一轮），最多等到 `since`（第一次发出中止的那一刻）之后的宽限；
	 * 返回等到了没有。
	 */
	async #settled(sessionId: string, turn: number, since: number): Promise<boolean> {
		const deadline = since + (this.deps.stopGraceMs ?? STOP_GRACE_MS);
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
		await sessions.appendTurnEnd(session.id, {
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

/** 用户说的一句话（`user_message`）：`steer` 是在做时说的（插话）。 */
const userMessage = (
	messageId: string,
	actor: Actor,
	text: string,
	steer = false,
): SessionEventBody => ({
	type: "user_message",
	message_id: messageId,
	text,
	steer,
	author: actor.nickname,
	author_user_id: actor.userId,
});

interface Failure {
	status: 409 | 503;
	code: SessionErrorCode;
	message: string;
	/** `turn_end` 的结局：模型不可用，或者别的失败。 */
	outcome: "model_unavailable" | "failed";
}

/**
 * `prompt` 没有得到 202 时，这一轮有没有可能已经在助手服务那边开始（协议：503 在登记之前判断，是确定没开始；助手服务明确拒绝的
 * 409、4xx 也是）：别的 5xx、超时、连接在发出请求之后断了是结果未知；连接没建起来（被拒绝、域名解析不了）请求没有发出去，
 * 一定没有开始（{@link AssistantUnreachableError.outcomeUnknown}）。
 */
function promptMayHaveStarted(error: unknown): boolean {
	if (error instanceof AssistantError) return error.status >= 500 && error.status !== 503;
	if (error instanceof AssistantUnreachableError) return error.outcomeUnknown;
	// 别的错（请求体序列化不了、环境变量生成出错……）发生在请求发出之前，这一轮一定没有开始。
	return false;
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
