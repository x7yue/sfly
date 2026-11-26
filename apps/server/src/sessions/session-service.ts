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

/**
 * 会话建于登录之前（没有发起人的用户，签发不了会话令牌）：不能再开始新的一轮（#547）。这样的会话只在开发和评测环境里有
 * （#494 之前建会话不要凭据）。
 */
export const PREDATES_LOGIN_MESSAGE = "这个会话建于登录之前，请新建一个会话";
const predatesLogin = () => rejected(409, "session_predates_login", PREDATES_LOGIN_MESSAGE);

/**
 * 这一轮开始时签发的会话令牌的原值。存储层在这一轮开始的事务里签发，会话有发起人的用户就一定有；没有是调用方先该拦住的
 * （建会话要带凭据、`say` 和 `#promote` 先看会话有没有发起人），到这里没有是代码错了，不是请求的错。
 */
function turnToken(token: string | undefined): string {
	if (token === undefined) throw new Error("这一轮开始时没有签发会话令牌：会话没有发起人的用户");
	return token;
}

/** 工作区在工作台上的路径。 */
const WORKDIR = "/work";

/**
 * 会话的标题：第一句话的前 60 个字（空白压成一个空格）。超过 60 个字时截短并在末尾加「…」，让人看得出后面还有。
 *
 * **「字」是看起来的字**（字形簇，`Intl.Segmenter`）：一个表情（含带零宽连接符的、带肤色的）、一面国旗、带变音符号的字母
 * 都是一个字，截点不落在它们中间；只取前 61 个字判断（够知道放不放得下、截在哪里，不必把整句话切完）。
 *
 * **截的位置不切开网址**：第 60 个字落在一个网址里时，截在网址之前——网址切断了既没有用、又像是完整的网址。
 * 网址是 `http://` 或 `https://`（不分大小写）开头、后面连着的 ASCII 可见字符：中文里网址后面常常直接跟中文或全角标点、
 * 没有空格，遇到它们网址就结束了（不然网址后面的话也被当成网址、一起丢掉）。例外：截在网址之前之后，前面剩下的内容
 * （去掉首尾空白和标点）不到 {@link TITLE_MIN_BEFORE_URL} 个字时（「看 https://很长的网址」只剩「看…」），
 * 不躲网址，照常截在第 60 个字（网址被切开）。截点之后的网址不用看。
 *
 * 在这之前创建的会话的标题没有改（没有省略号、按旧的规则截），页面照原样显示。
 */
export const TITLE_CHARS = 60;
/** 截在网址之前时，前面至少要留下这么多个字（去掉首尾空白和标点之后），否则不躲网址。 */
export const TITLE_MIN_BEFORE_URL = 10;
const TITLE_URL = /https?:\/\/[\x21-\x7e]+/giu;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 文字里前 `limit` 个字（字形簇）各自的起点（字符串下标）；不足 `limit` 个时就是全部。 */
function graphemeStarts(text: string, limit: number): number[] {
	const starts: number[] = [];
	for (const { index } of GRAPHEMES.segment(text)) {
		starts.push(index);
		if (starts.length >= limit) break;
	}
	return starts;
}

/** 网址前面的内容去掉首尾的空白和标点之后，够不够 {@link TITLE_MIN_BEFORE_URL} 个字。 */
function worthKeeping(before: string): boolean {
	const content = before.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
	return graphemeStarts(content, TITLE_MIN_BEFORE_URL).length >= TITLE_MIN_BEFORE_URL;
}

export function titleOf(text: string): string {
	const flat = text.trim().replace(/\s+/g, " ");
	const starts = graphemeStarts(flat, TITLE_CHARS + 1);
	if (starts.length <= TITLE_CHARS) return flat;
	let cut = starts[TITLE_CHARS] as number;
	for (const match of flat.matchAll(TITLE_URL)) {
		const start = match.index;
		// 截点之后的网址不用看。
		if (start >= cut) break;
		// 网址在截点之前就结束了：不用躲，看下一个。
		if (start + match[0].length <= cut) continue;
		// 截点落在这个网址里：前面留得下足够的内容就截在网址之前，留不下就只好截在网址里。
		if (worthKeeping(flat.slice(0, start))) cut = start;
		break;
	}
	return `${flat.slice(0, cut).trimEnd()}…`;
}

/**
 * 一个「在做」的会话多久没有持久事件，就当作这一轮中断了（毫秒）：一轮最长 20 分钟（#540），留出余量。
 * 控制面崩溃或重启、助手服务没有回话时，没有人会写这一轮的 `turn_end`，会话永远停在「在做」，
 * 这个项目就再也开不了新的一轮（同一个项目同一时刻只跑一轮）：这是兜底。断线之后的续传和助手服务重启之后的中断由事件连接的
 * `hello` 处理（#545，{@link SessionService.assistantRestarted}）；**事件连接连不上的时候兜底不动**：连不上不等于这一轮没在做。
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

/** 助手服务重启了，在做的会话补的 `interrupted` 的原因（协议和 #545 写定的这一句）。 */
export const ASSISTANT_RESTARTED_REASON =
	"助手服务重启了；工作区和已经触发的运行不受影响，说一句话可以接着做";

/** 控制面和助手服务断开太久、错过的事件已经补不回来时，在做的会话里写的 `events_lost` 提示。 */
export const EVENTS_LOST_MESSAGE = "控制面和助手服务断开太久，这一段过程没有记下";

/**
 * 控制面和助手服务的事件流还没连上（刚启动、或断了正在退避重连，间隔 1 到 30 秒）时，就绪状态和新的一轮写的说明（#545）：这时开始一轮的话，
 * 助手服务发出的事件到不了控制面（持久的事件之后靠续传补回，但增量、工具输出这些不持久的就丢了），时间线上这一轮会缺东西
 * （#760 审查在离线整套里碰到过：这一轮没有工具调用）。所以事件流连上之前不开始新的一轮，就绪状态写助手服务连不上。
 */
export const EVENTS_NOT_CONNECTED_MESSAGE =
	"助手服务的事件流还没有连上（控制面刚启动或正在重新连接），过几秒再试";

/** 关闭时最多等后台的事收尾多久（毫秒）：它们在放弃等待，只有正在发出去的命令要等它回来或超时。 */
export const CLOSE_DRAIN_MS = 500;

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
	 * 控制面和助手服务的事件连接此刻连着没有（`AssistantConnection.connected`，没有配置助手服务时不传）。连不上期间助手服务那边
	 * 这一轮可能还在做，安静不是出事了：兜底（{@link SessionService.expireStale}）这时不把在做的会话判成中断，等连上之后由 `hello` 说了算
	 * （{@link SessionService.assistantRestarted}、{@link SessionService.assistantEventsLost}）。**没连上时也不开始新的一轮**：就绪状态写助手服务
	 * 连不上、建会话和说话 503 `assistant_unavailable`（{@link EVENTS_NOT_CONNECTED_MESSAGE}）：这时助手服务发出的增量、工具输出到不了控制面。
	 */
	assistantConnected?: () => boolean;
	/**
	 * 会话结束（会话已经改成 `ended`、`session_ended` 已经写下）之后调用（#544 留好的接口）：尽力而为，抛的错只进日志，不影响结束。
	 * 会话令牌的吊销不在这里：它在会话结束的事务里（{@link SessionStore.end}，#547），不靠一个事后的回调。
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

	/**
	 * **正在结束**的会话 → 正在进行的那一次结束（{@link SessionService.end} 一开始就记上，做完摘掉）：这期间不为它开始任何一轮
	 * （{@link SessionService.#promote} 和「结局写下之后把排着的话开成新的一轮」都跳过它，已经开始、还没发出 `prompt` 的也不发），
	 * 对它说话回 409 `session_ended`。结束会话要先把排着的话移出队列、停掉在做的一轮、等到结局，才写 `session_ended`；不记这个，
	 * 结局一写下后台的开始就抢在移出队列之前把排着的话开成了新的一轮，一个正在被结束的会话又把一轮交给了助手服务。
	 * **同一个会话同时只有一次结束在进行**：第二次 `/end` 等第一次的结果（两次都成功或都失败），不会因为自己出错就把第一次的记号摘掉。
	 */
	readonly #endings = new Map<string, Promise<Outcome<null>>>();

	/**
	 * **暂时不接着开始排队的会话**的项目：从队里开始的一轮，`prompt` 确定没开始、原因是连不上助手服务或者助手服务回 503（含 `process_limit`）
	 * 时，这一轮照协议以失败结束，但这个项目不因为这条结局接着开始下一个（不然助手服务这一刻起不了新的一轮，排着的一个接一个失败）：
	 * 剩下的留在队里，等下一次兜底（{@link SessionService.startWaiting}，每分钟）或者这个项目里下一次有人说话。任何情况下一次最多失败队首
	 * 一个。已知的情况：助手服务一直是「全都在做」（进程数到了上限、没有空闲的可以回收）时，排队的会话按兜底的节奏每分钟失败一个，
	 * 这个项目里每有人说一句话（新建会话、空闲的会话说话）也会再失败一个（说话解除暂停、再试一次），原因写的是进程数到了上限；
	 * 让助手服务报「在做的进程数」、控制面据此先不开始，是开放给用户之前要做的事（#544）。
	 * **`#promote` 自己也看暂停**（{@link SessionStore.promoteNext} 的 `held`）：一轮结束触发的开始和兜底扫描触发的开始可以同时在跑，
	 * 后跑的那次走到开始时队首已经没开始成、项目已经暂停，不能照样开始下一个。
	 */
	readonly #paused = new Set<ProjectId>();

	/** 等某个会话这一轮的结局的人（{@link SessionService.#settled}）：结局写下（`onTurnEnd`）和关闭时唤醒，不靠轮询。 */
	readonly #waiters = new Map<string, Set<() => void>>();

	/**
	 * 事件连接最近一次连上（`hello` 处理完）的时刻（毫秒，控制面的时钟）：兜底的 30 分钟从它算起（{@link SessionService.expireStale}）。
	 * 没连上过（或没有配置助手服务）时是 undefined。
	 */
	#connectedAt: number | undefined;

	/** 控制面在关闭：后台的「补发中止、等结局」放弃等待，不为它们延长关闭的上限，也不在关闭时自己补结局。 */
	#closing = false;

	constructor(private readonly deps: SessionServiceDeps) {
		// 一轮结束、项目的位置空出来了：叫醒在等这一轮结局的人，让排队的最早一个开始。不等它（交给助手服务最多等 10 秒），
		// 错误自己记日志。
		deps.sessions.onTurnEnd((project, sessionId) => {
			this.#wake(sessionId);
			// 从队里开始的一轮没有交出去（助手服务连不上或回 503）、这条结局是为它写的：这个项目先不接着开始下一个。
			if (this.#paused.has(project)) return;
			this.#later(() => this.#promote(project));
		});
	}

	#wake(sessionId: string): void {
		for (const wake of this.#waiters.get(sessionId) ?? []) wake();
	}

	/** 后台做一件事：不等、错误进日志；{@link idle} 等它们做完。 */
	#later(run: () => Promise<void>): void {
		const task = run()
			.catch((error) => this.deps.log?.("开始排队中的会话失败", error))
			.finally(() => this.#background.delete(task));
		this.#background.add(task);
	}

	/** 等后台的事做完（测试里等排队的会话开始、等补发中止和等结局做完）。 */
	async idle(): Promise<void> {
		while (this.#background.size > 0) await Promise.all([...this.#background]);
	}

	/**
	 * 控制面关闭时调用：后台「补发中止、等结局」放弃等待（叫醒它们，它们看到在关闭就走，**不补结局**），不为它们延长关闭的上限。
	 * 重启之后这些会话还是在做的：中止已经发出，助手服务带回结局就照常收下，带不回来由兜底结束（#545）。已经在发出去的命令
	 * 最多再等一小会儿（{@link CLOSE_DRAIN_MS}），不等它们的 10 秒超时。
	 */
	async close(): Promise<void> {
		this.#closing = true;
		for (const sessionId of [...this.#waiters.keys()]) this.#wake(sessionId);
		await Promise.race([
			this.idle(),
			new Promise((resolve) => setTimeout(resolve, CLOSE_DRAIN_MS)),
		]);
	}

	// ---- 就绪状态 ----

	/** 事件流此刻连着没有；没有登记「事件连接状态」的（没有配置助手服务、或测试里没给）当作连着。 */
	#eventsConnected(): boolean {
		return this.deps.assistantConnected?.() ?? true;
	}

	/**
	 * 助手服务的 `/health`（缓存 {@link HEALTH_TTL_MS}，最多等 {@link HEALTH_TIMEOUT_MS}，同时来的请求共用一次）；
	 * 连不上时是原因。
	 */
	async #assistantHealth(fresh = false): Promise<{ health: AssistantHealth } | { error: string }> {
		const { client, clock } = this.deps;
		if (!client) return { error: "助手没有配置" };
		const now = clock.now().getTime();
		// `fresh`：开始排队的会话之前问的是此刻的状态，不用缓存也不和别人共用一次（缓存里的「能用」可能已经过期：队首刚因为连不上失败，
		// 这条结局触发的下一次开始用的不能还是同一份缓存）。
		if (!fresh) {
			if (this.#health && now - this.#health.at < HEALTH_TTL_MS) return this.#health.result;
			if (this.#healthAsking) return this.#healthAsking;
		}
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
			if (this.#healthAsking === asking) this.#healthAsking = undefined;
		});
		if (!fresh) this.#healthAsking = asking;
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
	 * 助手此刻能不能用（每次列出会话时算一次）：没配地址或密钥、助手服务连不上（`/health` 不通）、模型没有配置或连不上
	 * （助手服务的 `/health` 里的 `model`，#548）、没设置工作台、工作台不在线，原因都列出来；`workbench` 是设置的工作台的名字。
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
			} else if (!this.#eventsConnected()) {
				// `/health` 通、事件流没连上：控制面正在（重新）连接，这时开始的一轮会丢事件，见 {@link EVENTS_NOT_CONNECTED_MESSAGE}。
				problems.push({ kind: "assistant_unreachable", message: EVENTS_NOT_CONNECTED_MESSAGE });
			} else {
				const model = modelProblem(health.health.model, this.deps.clock.now().getTime());
				if (model) problems.push(model);
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

	/**
	 * 写接口的前提：助手配置好了（没配是 503 `assistant_not_configured`）、有可用的工作台（没有是 503 `assistant_unavailable`）、
	 * 模型没有问题（助手服务的 `/health` 说没有配置或连不上，是 503 `model_unavailable`，写明原因，#548）：这三种都在写任何东西之前挡掉，
	 * 不建会话、不写 `user_message`。助手服务的 `/health` 问不通时不拦：交给后面的 `prompt` 去失败，照旧报 `assistant_unavailable`。
	 */
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
		// 事件流没连上：不开始新的一轮（建会话、对空闲的会话说话、排队的轮到它都先过这里），不建会话、不写 `user_message`。
		// 说明和就绪状态一致：助手服务的 `/health` 不通时写它不通的原因（密钥不一致、连不上……），通的话才写事件流还没连上。
		if (!this.#eventsConnected()) {
			const health = await this.#assistantHealth();
			return rejected(
				503,
				"assistant_unavailable",
				"error" in health ? health.error : EVENTS_NOT_CONNECTED_MESSAGE,
			);
		}
		const workbench = await this.#workbench(project);
		if ("problem" in workbench) {
			return rejected(503, "assistant_unavailable", workbench.problem.message);
		}
		const health = await this.#assistantHealth();
		if (!("error" in health)) {
			const model = modelProblem(health.health.model, this.deps.clock.now().getTime());
			if (model) return rejected(503, "model_unavailable", model.message);
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
		// 建会话要有发起人的用户（会话令牌代他干活，`created_by_user_id` 从凭据取）：路由在这之前已经对不带凭据的请求回 401，
		// 到这里没有用户是调用方的错，不是请求的错。
		if (actor.userId === null) throw new Error("建会话要有发起人的用户：请求要带登录或个人令牌");
		const ready = await this.#ready(project);
		if (!ready.ok) return ready;
		this.#unpause(project);
		const messageId = randomUUID();
		const created = await sessions.createWithTurn(
			{
				project,
				title: titleOf(text),
				createdBy: actor.nickname,
				createdByUserId: actor.userId,
			},
			userMessage(messageId, actor, text),
			(id, turn) => this.#openGate(id, turn),
		);
		const { session } = created;
		if (created.queued) {
			await this.#announceQueue(project);
			return { ok: true, value: (await sessions.find(session.id)) ?? session };
		}
		// 没接住：不留下会话（这一轮的结局写下之后删掉；结果未知的话等到结局写下才删，那之前项目的位置不空出来）。**但只在会话没有被碰过时
		// 才删**（{@link SessionStore.deleteUntouched}，在锁着会话那一行的事务里核对）：等结局的那段时间别人对它说的话回了 200，
		// 不能跟着会话一起没了，更不能在那句话已经开始成第 2 轮之后删会话；**助手服务其实收下了这一轮、做了事**（这一轮里有它的事件，
		// 包括它带回的结局）也算碰过：工作区里的改动留着，会话记录不能没；有人正在结束这个会话也不删（让结束做完）。
		const sent = await this.#handOver(
			session,
			1,
			{ messageId, text, actor, token: turnToken(created.token) },
			ready.value,
			{
				afterFailure: async ({ endedByAssistant }) => {
					if (endedByAssistant || this.#endings.has(session.id)) return;
					await sessions.deleteUntouched(session.id, 1);
				},
			},
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
			// 正在结束的会话不再接受消息（`end()` 一开始就记上；写 `session_ended` 之前这段时间说的话也不能开始新的一轮）。
			if (this.#endings.has(session.id)) {
				return rejected(409, "session_ended", "这个会话已经结束或者正在结束，不再接受消息");
			}
			const current = (await sessions.find(session.id)) ?? session;
			if (current.status === "running") {
				// 正在停止（控制面发出了中止、结局还没有写下）：这句话是新的一轮的开头，排在这一轮后面，不是插话。在做、却有排队时间的会话
				// 只能是正在停止、已经有话排在后面的（控制面重启之后内存里的标记没了，这个判断仍然成立）。
				if (
					current.queuedAt !== null ||
					this.#stopping.get(current.id) === effectiveTurn(current)
				) {
					// 这句话是下一轮的开头，要签发令牌：建于登录之前的会话（没有发起人的用户）不能再开始新的一轮，
					// 由存储层在事务里判断（`noAuthor`）。
					const behind = await sessions.queueBehind(
						current.id,
						userMessage(randomUUID(), actor, text),
					);
					if (behind.queued) {
						await this.#announceQueue(current.projectId);
						return { ok: true, value: { seq: behind.event.seq } };
					}
					if (behind.noAuthor) return predatesLogin();
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
			this.#unpause(session.projectId);
			const messageId = randomUUID();
			const begun = await sessions.beginTurn(
				session.id,
				session.projectId,
				userMessage(messageId, actor, text),
				(id, turn) => this.#openGate(id, turn),
			);
			switch (begun.outcome) {
				case "started": {
					const sent = await this.#handOver(
						session,
						begun.turn,
						{ messageId, text, actor, token: turnToken(begun.token) },
						ready.value,
					);
					if (!sent.ok) return sent;
					return { ok: true, value: { seq: begun.events[0]?.seq ?? 0 } };
				}
				case "queued":
					await this.#announceQueue(session.projectId);
					return { ok: true, value: { seq: begun.events[0]?.seq ?? 0 } };
				case "no_author":
					// 建于登录之前的会话（没有发起人的用户，签发不了令牌）不能再开始新的一轮，要新建一个会话；在存储层的事务里判断，
					// 排队中、已结束的会话照常走下面的 409。
					return predatesLogin();
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
			if (this.#closing) return { ok: false, error, noTurn };
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
	 * 剩下的排队的位置前进了，各推一条 `turn_queued`。交给助手服务没接住的话，这一轮以失败结束：确定没开始、原因是连不上助手服务
	 * 或它回 503 时，这个项目先不接着开始下一个（{@link SessionService.#paused}，等兜底或者下一次有人说话）；回 409、4xx、结果未知
	 * 时下一个照常开始。没有排队的、项目里有会话在做、这个项目暂停着、控制面在关闭、助手服务和工作台此刻不能用时什么也不做（排队的
	 * 留在队里，兜底的扫描再来）；重复调用无害。
	 */
	async #promote(project: ProjectId): Promise<void> {
		const { sessions } = this.deps;
		if (this.#closing) return;
		// 助手服务或工作台此刻不能用（控制面刚重启、工作台的 Agent 还没重新连上、助手服务连不上）：排队的留在队里，不把它们的话一个个
		// 失败掉；兜底的扫描（每分钟）和这个项目下一次有一轮结束会再来。**问的是此刻的 `/health`，不用缓存**：缓存里的「能用」可能已经
		// 过期，队首刚因为连不上失败、这条结局触发的这一次开始用的不能还是同一份。检查和 `prompt` 之间助手服务才不能用的，队首那一个会
		// 失败一次（协议：确定没开始，这一轮立即以失败结束），**这个项目不因为这条结局接着开始下一个**（{@link SessionService.#paused}），
		// 它后面的留在队里：任何情况下一次最多失败队首一个。
		// 没有排队的就什么也不问（每一轮结束都会来这里，不为它去问助手服务）。
		if ((await sessions.queued(project)).length === 0) return;
		const ready = await this.#ready(project);
		if (!ready.ok) {
			this.deps.log?.(`项目 ${project} 里排队的会话先不开始：${ready.message}`);
			return;
		}
		// 不看 `/health` 里的进程数：它是活着的 pi 进程数，空闲常驻的也算（一个会话一个进程），到了上限时助手服务先关掉最久没用的空闲进程，
		// 只有全都在做才回 503 `process_limit`；照进程数不开始的话，各做过一轮的会话一多，排队的就永远不开始了。
		const health = await this.#assistantHealth(true);
		if ("error" in health) {
			this.deps.log?.(
				`项目 ${project} 里排队的会话先不开始：助手服务的 /health 没有回应（${health.error}）`,
			);
			return;
		}
		// 模型没有配置或连不上（#548）：队首不白失败一次，留在队里等模型好了（兜底的扫描每分钟再来）。`#ready` 看的是缓存的 `/health`，
		// 缓存里的「能用」可能已经过期，这里用刚问的这一份再看一次。
		const model = modelProblem(health.health.model, this.deps.clock.now().getTime());
		if (model) {
			this.deps.log?.(`项目 ${project} 里排队的会话先不开始：${model.message}`);
			return;
		}
		// 不开始的：控制面在关闭（这一次是关闭之前开始的、还在路上）、这个项目暂停着（队首刚没开始成：结局触发的开始和兜底扫描触发的开始
		// 可以同时在跑，后跑的那次走到这里时项目已经暂停）、这个会话正在结束（{@link SessionService.#endings}，排在它后面的照常）。
		// 在会话的串行链上、开始之前再看一次。
		const promoted = await sessions.promoteNext(
			project,
			(id) => this.#closing || this.#paused.has(project) || this.#endings.has(id),
			(id, turn) => this.#openGate(id, turn),
		);
		if (!promoted) return;
		// 推排位只是通知，出错不能挡住这一轮交给助手服务。
		await this.#announceQueue(project).catch((error) =>
			this.deps.log?.("推送排队的位置失败", error),
		);
		const { session, turn, message, token } = promoted;
		// 排队中的会话建于登录之前（没有发起人的用户）：签发不了这一轮的令牌，这一轮按失败结束，让排在后面的有机会
		// （结局写下触发下一个开始）。只发生在开发和评测环境里的旧会话。
		if (token === undefined) {
			// 这一轮的「插话等 202」的门不会有 202 了：摘掉；留着的插话由这条结局补 `steer_dropped`。
			if (this.#handOvers.get(session.id)?.turn === turn) this.#handOvers.delete(session.id);
			await sessions.appendTurnEnd(session.id, {
				type: "turn_end",
				turn,
				outcome: "failed",
				reason: PREDATES_LOGIN_MESSAGE,
				steps: 0,
				model_calls: 0,
				duration_ms: 0,
			});
			return;
		}
		const actor: Actor = {
			nickname: message.author,
			via: null,
			userId: message.author_user_id,
			token: null,
			sessionId: null,
		};
		// 没接住时 `#handOver` 自己补了失败的结局；连不上或 503 的话这个项目先不接着开始下一个（`fromQueue`）。
		await this.#handOver(
			session,
			turn,
			{ messageId: message.message_id, text: message.text, actor, token },
			ready.value,
			{ fromQueue: true },
		);
	}

	/** 这个项目里有人说话（助手服务和工作台能用）：之前因为开始不成而暂停的，现在再试一次开始排队的。 */
	#unpause(project: ProjectId): void {
		if (this.#paused.delete(project)) this.#later(() => this.#promote(project));
	}

	/**
	 * 兜底：有会话排队、项目里却没有会话在做的（控制面重启、开始它的那一次没做完），开始排队最早的那个。控制面启动时和
	 * 每分钟（`expireStale` 之后）调用。返回开始了几个项目的。
	 */
	async startWaiting(): Promise<number> {
		// 兜底的节奏就是暂停的项目重新试的节奏（{@link SessionService.#paused}）。
		this.#paused.clear();
		const projects = await this.deps.sessions.projectsWaitingForTurn();
		for (const project of projects) this.#later(() => this.#promote(project));
		return projects.length;
	}

	/**
	 * 给项目里每个排队的会话推一条 `turn_queued`（不持久）：排第几、在等哪个会话和它的发起人。「排队的」包括排队中的，和停止途中说了话、
	 * 排在这一轮后面的在做的会话（{@link SessionStore.queueOrder}，按说话的时刻排）。队列变化时调用（有会话排上队、有会话被停止或
	 * 结束、排队的开始了）。**项目里没有会话在做时也推，`waiting_for` 是 null**（#545：排队的会话在等助手服务或工作台恢复、等下一次
	 * 开始，没有「在等谁」可写；以前这时不推，别的标签页和别的人要等这一轮开始才看得到）。
	 * **它不在会话的链上**（读库、发布都在链外）：事件流的快照取的排位可能比它新发布的 `turn_queued` 旧（见 `SessionStore.follow` 里的
	 * 已知边界）：只影响排位，到下一次队列变化纠正。
	 */
	async #announceQueue(project: ProjectId): Promise<void> {
		const { sessions } = this.deps;
		const queued = await sessions.queueOrder(project);
		if (queued.length === 0) return;
		const running = await sessions.running(project);
		const waitingFor = running
			? { session_id: running.id, title: running.title, created_by: running.createdBy }
			: null;
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
	 * 说了话的在做的会话也有名次（在等的是它自己正在停止的这一轮）。和 `turn_queued`、快照同一个算法（{@link SessionStore.queueState}）。
	 */
	async queueInfo(
		row: SessionRow,
	): Promise<{ position: number | null; waitingFor: SessionView["waiting_for"] }> {
		return this.deps.sessions.queueState(row);
	}

	/** 设上这一轮「插话等 202」的门（会话刚变成在做，存储层在提交之后、释放链之前调用）。 */
	#openGate(sessionId: string, turn: number): HandOver {
		const gate: HandOver = { turn, held: [] };
		this.#handOvers.set(sessionId, gate);
		return gate;
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
		message: { messageId: string; text: string; actor: Actor; token: string },
		ready: { client: AssistantClient; target: WorkbenchTarget },
		options: {
			/** 这一轮是从队里开始的：确定没开始、原因是连不上助手服务或 503 时，这个项目不接着开始下一个（{@link SessionService.#paused}）。 */
			fromQueue?: boolean;
			/** 这一轮的结局写下之后调用；`endedByAssistant`：结局是助手服务带回的（或这一轮是自己结束的），不是控制面补的。 */
			afterFailure?: (info: { endedByAssistant: boolean }) => Promise<void>;
		} = {},
	): Promise<Outcome<{ seq: number }>> {
		const { sessions } = this.deps;
		// 门在会话变成在做的同一步就设上了（存储层的 `started` 回调）：这一轮的插话从一开始就先留着，不会先于 `prompt` 发出去。
		const opened = this.#handOvers.get(session.id);
		const gate: HandOver =
			opened && opened.turn === turn ? opened : this.#openGate(session.id, turn);
		// 发 `prompt` 之前再看一眼：会话正在结束（这一轮刚开始、`prompt` 还没发出去时 `/end` 进来了）就不发：这一轮没有交给助手服务，
		// 照停止结束它（留着的插话各补一条 `steer_dropped`，随这条结局写下），不留下一个在「正在结束」之后才发出的 `prompt`。
		if (this.#endings.has(session.id)) {
			if (this.#handOvers.get(session.id) === gate) this.#handOvers.delete(session.id);
			gate.held.splice(0);
			if (!this.#closing) {
				await sessions.appendTurnEnd(session.id, {
					type: "turn_end",
					turn,
					outcome: "stopped",
					reason: "会话正在结束，这一轮没有交给助手服务",
					steps: 0,
					model_calls: 0,
					duration_ms: 0,
				});
			}
			return rejected(409, "session_ended", "这个会话已经结束或者正在结束，不再接受消息");
		}
		try {
			await ready.client.prompt(session.id, {
				turn,
				message_id: message.messageId,
				text: message.text,
				session: { title: session.title, created_by: session.createdBy },
				workbench: ready.target,
				...commandEnv(message.actor, message.token),
			});
		} catch (error) {
			// 下面三步是同步的，中间没有别的请求插进来：摘下留着插话的地方（之后新来的插话直接转发）、取走已经留着的、结果未知的标成正在停止。
			if (this.#handOvers.get(session.id) === gate) this.#handOvers.delete(session.id);
			const held = gate.held.splice(0);
			const unknown = promptMayHaveStarted(error);
			if (unknown) this.#markStopping(session.id, turn);
			this.deps.log?.(`助手服务没有接住会话 ${session.id} 的第 ${turn} 轮`, error);
			const failure = describeFailure(error);
			// 控制面在关闭：连接池已经关了，不再写结局、不再删会话（重启之后这一轮由助手服务带回结局，带不回来由兜底结束，#545）。
			if (this.#closing) return rejected(failure.status, failure.code, failure.message);
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
				// 先记下再写结局：这条结局触发的下一次开始（`onTurnEnd`）看到的就是「先不接着开始」。
				if (options.fromQueue && assistantCannotStart(error)) this.#paused.add(session.projectId);
				await sessions.appendTurnEnd(session.id, failureEnd(turn, failure));
				await options.afterFailure?.({ endedByAssistant: false });
				return rejected(failure.status, failure.code, failure.message);
			}
			this.#later(async () => {
				const endedByAssistant = await this.#abortAndSettle(session.id, turn, ready.client, () =>
					sessions.appendTurnEnd(session.id, failureEnd(turn, failure)),
				);
				// 关闭时 `#abortAndSettle` 放弃等待、什么也没写：也不删会话。
				if (this.#closing) return;
				await options.afterFailure?.({ endedByAssistant });
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
		// 连不上助手服务：安静是正常的，不判中断（见 `SessionServiceDeps.assistantConnected`）。
		if (this.deps.assistantConnected && !this.deps.assistantConnected()) return 0;
		const before = clock.now().getTime() - STALE_TURN_MS;
		// 30 分钟按 max(最近的动静, 事件连接最近一次连上的时刻) 算：控制面停机很久（或断开很久）之后连上，助手服务那边这一段时间里做完的事件
		// 还在补发的路上，会话的 `last_activity_at` 因此是旧的，不能在连上的下一刻就把它们判成中断，补发的结局随后又因为这一轮已经结束被丢掉
		// （#764 审查的探针 P2）。连上之后 30 分钟内没有会话会被判中断；一轮最长 20 分钟，助手服务自己会结束它。
		if (this.#connectedAt !== undefined && this.#connectedAt >= before) return 0;
		const stale = await sessions.staleRunning(new Date(before));
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
	 * 事件连接连上了（`hello` 处理完、`AssistantConnection.connected` 已经是真，每次连上都调，包括控制面刚启动的第一次）：记下时刻，
	 * 再开始排队的会话。事件流没连上时不开始新的一轮（{@link EVENTS_NOT_CONNECTED_MESSAGE}），所以控制面启动时的 `startWaiting`、
	 * 助手服务重启补结局触发的开始都发生在连上之前，被挡掉了；这里补一次，不让它们等一分钟后兜底的扫描。
	 */
	async onAssistantConnected(): Promise<void> {
		this.#connectedAt = this.deps.clock.now().getTime();
		await this.startWaiting();
	}

	/**
	 * 助手服务重启了（事件连接的 `hello` 里的纪元和控制面记着的不同，#545）：pi 进程随助手服务结束，这些会话这一轮没有人会带回结局。
	 * `candidates` 是连接断开那一刻在做的会话（会话 → 轮次）：只结束其中**还是同一轮**的——连接断开之后才开始的一轮是在新的助手服务上
	 * 开始的（用户在助手服务回来、事件连接还没重连上的这段时间说了话），它没有被打断。没有 `candidates`（不知道）时一个也不结束，
	 * 留给兜底。每个会话补一条 `interrupted` 的 `turn_end`、改回空闲（和一般的 `turn_end` 一样先为没有确认送到的插话补
	 * `steer_dropped`），排队的接着开始（`onTurnEnd`，按 #544 的规则）；工作区和已经触发的运行不受影响，说一句话可以接着做。
	 * 返回结束了几个。
	 */
	async assistantRestarted(candidates: ReadonlyMap<string, number> | undefined): Promise<number> {
		if (candidates === undefined) return 0;
		let ended = 0;
		for (const session of await this.deps.sessions.allRunning()) {
			const turn = effectiveTurn(session);
			if (candidates.get(session.id) !== turn) continue;
			await this.#endTurn(session, turn, "interrupted", ASSISTANT_RESTARTED_REASON);
			ended++;
		}
		return ended;
	}

	/**
	 * 控制面和助手服务断开太久，错过的事件已经被助手服务挤出了缓冲（纪元相同、`hello.gap` 为真，#545）：在做的会话各补一条
	 * `events_lost` 的提示，照常接着收。返回写了几条。
	 */
	async assistantEventsLost(): Promise<number> {
		let written = 0;
		for (const session of await this.deps.sessions.allRunning()) {
			await this.deps.sessions.append(session.id, {
				type: "notice",
				kind: "events_lost",
				message: EVENTS_LOST_MESSAGE,
			});
			written++;
		}
		return written;
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
		for (let attempt = 0; attempt < 3; attempt++) {
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
			// 在做、而且已经有话排在这一轮后面（停止途中说了话、又点了一次停止）：把那句话移出队列（`queue_cancelled`）。停止就是「在做的
			// 一轮停掉、排着的话撤掉」，三种状态一个说法。只撤**这次停止之前**就排着的：这次停止的等待期间说的话，是新的一轮的开头，照旧排在
			// 后面。撤的时候状态可能刚变（这一轮刚好结束了、排着的话已经被开始）：没撤成就按新的状态再来一次。
			if (current.queuedAt !== null) {
				const cancelled = await sessions.cancelQueued(current.id);
				if (cancelled.cancelled) await this.#announceQueue(current.projectId);
				else continue;
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
		return rejected(409, "turn_running", "会话的状态一直在变，稍后再停止一次");
	}

	/**
	 * 结束会话：之后不再接受消息（409 `session_ended`），工作区、提交、场景版本、运行都留着，不删除任何东西。
	 * 协议「结束会话」的先后：在做的一轮先停止（{@link SessionService.stop}，**等到这一轮的结局**），排队的移出队列
	 * （`queue_cancelled`）；然后**写 `session_ended`**（会话改成 `ended`，和「此刻没有一轮在做、没有在排队」的核对在一个事务里，
	 * {@link SessionStore.end}），**写下之后**才把 `end` 发给助手服务（它结束这个会话的进程；尽力而为：连不上时会话照样已经结束，
	 * 进程由助手服务自己回收，#545）。写下之后控制面不再为这个会话发 `prompt` 和 `steer`：助手服务不记得会话结束了，`end` 之后来的
	 * `prompt` 它会照常做，所以先写下结束、再发 `end`，中间不会有新的一轮开始。已经结束的再调用无害（什么也不写）。
	 * 助手没有配置时 503（和别的写一样）。结束之后调用 `onEnded`（先于 `end` 的命令：不等助手服务；会话令牌在 `SessionStore.end` 的事务里已经吊销了）。
	 * **一开始就把会话记成「正在结束」**（{@link SessionService.#endings}）：写下 `session_ended` 之前，不为它开始任何一轮（后台的
	 * {@link SessionService.#promote} 跳过它，已经开始、还没发出 `prompt` 的也不发），对它说话回 409 `session_ended`，排着的话
	 * （含刚排进来的）移出队列。**同一个会话同时只有一次结束在进行**：第二次调用等第一次的结果（两次的响应一样），不会因为自己
	 * 出错就把第一次的记号摘掉。停止到写下 `session_ended` 之间会话又开始了一轮（说话和结束同时到）就再停一次，最多三次，还不行是
	 * 409 `turn_running`。
	 */
	async end(session: SessionRow, actor: Actor): Promise<Outcome<null>> {
		const configured = await this.#configured();
		if (!configured.ok) return configured;
		// 下面的读和写之间没有 `await`：两次调用不会各开一次。
		const running = this.#endings.get(session.id);
		if (running) return running;
		// 一开始就记成「正在结束」：下面停止、等结局的这段时间，不为它开始任何一轮（排着的话、刚排进来的话都在这里移出队列），
		// 对它说话回 409。没做成（出错、重试用尽）也要摘掉（只摘自己这一次的）。
		const run: Promise<Outcome<null>> = this.#end(session, actor, configured.value).finally(() => {
			if (this.#endings.get(session.id) === run) this.#endings.delete(session.id);
		});
		this.#endings.set(session.id, run);
		return run;
	}

	async #end(session: SessionRow, actor: Actor, client: AssistantClient): Promise<Outcome<null>> {
		const { sessions } = this.deps;
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
				await client.end(current.id);
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
				// 结局写下了、或者控制面在关闭（放弃等待，不补）：都不补。
				const settled = await this.#settled(
					sessionId,
					turn,
					sentAt + (this.deps.stopGraceMs ?? STOP_GRACE_MS),
				);
				if (settled !== "timeout") return true;
			}
			if (this.#closing) return true;
			await supply();
			return false;
		} finally {
			if (this.#stopping.get(sessionId) === turn) this.#stopping.delete(sessionId);
		}
	}

	/**
	 * 等第 `turn` 轮结束（会话离开「在做」，或已经在做下一轮），最多等到 `deadline`（第一次发出中止的那一刻加期限）；
	 * 结局写下（`SessionStore.onTurnEnd`）时被叫醒，不靠轮询。先登记再读库：读库之前就写下的结局由这一次读到，之后写下的由叫醒告诉。
	 * 返回 `done`（这一轮已经结束）、`timeout`（到期了）、`closing`（控制面在关闭）。
	 */
	async #settled(
		sessionId: string,
		turn: number,
		deadline: number,
	): Promise<"done" | "timeout" | "closing"> {
		for (;;) {
			let wake: () => void = () => {};
			const woken = new Promise<void>((resolve) => {
				wake = resolve;
			});
			const waiting = this.#waiters.get(sessionId) ?? new Set<() => void>();
			this.#waiters.set(sessionId, waiting);
			waiting.add(wake);
			let timer: NodeJS.Timeout | undefined;
			try {
				if (this.#closing) return "closing";
				const row = await this.deps.sessions.find(sessionId);
				if (!row || row.status !== "running" || effectiveTurn(row) !== turn) return "done";
				const left = deadline - Date.now();
				if (left <= 0) return "timeout";
				await Promise.race([
					woken,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, left);
					}),
				]);
			} finally {
				clearTimeout(timer);
				waiting.delete(wake);
				if (waiting.size === 0 && this.#waiters.get(sessionId) === waiting) {
					this.#waiters.delete(sessionId);
				}
			}
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
 * 409、4xx 也是）：别的 5xx、超时、连接在发出请求之后断了是结果未知；**只有请求一个字节都没发出去**（连接没建起来：被拒绝、
 * 域名解析不了、没有路由、建立连接就超时）才是一定没有开始，认不出的错也算未知（白名单，
 * {@link AssistantUnreachableError.outcomeUnknown}、`outcomeUnknown()`）。
 */
function promptMayHaveStarted(error: unknown): boolean {
	if (error instanceof AssistantError) return error.status >= 500 && error.status !== 503;
	if (error instanceof AssistantUnreachableError) return error.outcomeUnknown;
	// 别的错（请求体序列化不了、环境变量生成出错……）发生在请求发出之前，这一轮一定没有开始。
	return false;
}

/**
 * 这一轮没有开始，原因是助手服务此刻起不了新的一轮：连不上（请求一个字节都没发出去），或者助手服务回 503（含 `process_limit`）。
 * 别的明确的拒绝（409、4xx）是这一个会话的事，不算；结果未知的也不算（{@link promptMayHaveStarted}）。
 */
function assistantCannotStart(error: unknown): boolean {
	if (error instanceof AssistantError) return error.status === 503;
	if (error instanceof AssistantUnreachableError) return !error.outcomeUnknown;
	return false;
}

/** 助手服务给的原因进就绪状态和错误说明之前截到这么长（它是助手服务自己写的一句话：文件路径、变量名、主机和端口）。 */
const MODEL_REASON_MAX_CHARS = 300;

/**
 * 助手服务的 `/health` 里模型的状态 → 就绪状态里的一项问题（#548）：没有配置写「没有配置模型：<缺什么>」（原因是助手服务写的，
 * 只有变量名和文件路径，没有值），连不上写「<原因>（上次检查：N 分钟前）」；没问题（含还没检查过、不知道端点）时没有。
 */
export function modelProblem(
	model: AssistantHealth["model"],
	now: number,
): ReadinessProblem | undefined {
	const reason = (model.reason ?? "").slice(0, MODEL_REASON_MAX_CHARS);
	if (!model.configured) {
		return {
			kind: "model_not_configured",
			message: `没有配置模型：${reason === "" ? "原因不明" : reason}`,
		};
	}
	if (model.reachable !== false) return undefined;
	const what = reason === "" ? "连不上模型端点" : reason;
	const ago =
		model.checked_at === null ? "" : `（上次检查：${agoText(now - Date.parse(model.checked_at))}）`;
	return { kind: "model_unreachable", message: `${what}${ago}` };
}

/** 「N 分钟前」：不到 1 分钟写「刚才」，不到 1 小时按分钟，再久按小时。 */
function agoText(elapsedMs: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
	if (minutes < 1) return "刚才";
	if (minutes < 60) return `${minutes} 分钟前`;
	return `${Math.floor(minutes / 60)} 小时前`;
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
