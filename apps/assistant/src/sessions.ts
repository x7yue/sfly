import { createHash } from "node:crypto";
import {
	createWriteStream,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ASSISTANT_ABORT_SETTLE_MS,
	ASSISTANT_STOP_WAIT_MS,
	type AssistantErrorCode,
	type AssistantEvent,
	type ErrorClass,
	type PromptCommandBody,
	type SteerCommandBody,
	type TurnLimit,
	type TurnOutcome,
} from "@sfly/schema";
import { type AgentClient, WORKBENCH_UNREACHABLE, WorkbenchError } from "./agent.js";
import type { EventBus } from "./bus.js";
import { type Clock, realClock, type Timer } from "./clock.js";
import { type LaunchPaths, prepareLaunch, writeContextFile } from "./launch.js";
import { modelEnvRefs } from "./models.js";
import { describeError } from "./output.js";
import { KILL_GRACE_MS, PiProcess } from "./pi-process.js";
import { forLog, Redactor } from "./redact.js";
import { mirrorSkillsLocally, workbenchSkillsDir, writeSkillsToWorkbench } from "./skills.js";
import { quote, type Steer, SteerBook } from "./steers.js";
import { TurnTranslator } from "./translate.js";
import type { TurnConfig } from "./turn-config.js";
import type { UpstreamError } from "./upstream-error.js";

/**
 * 看管 pi 进程和一轮（#540）：一个会话一个 pi 进程（RPC 模式），一轮从 `prompt` 开始，到 pi 报告 `agent_settled`、
 * 到了上限、被停止或 pi 进程退出为止，以一条 `turn_end` 结束。
 *
 * - 先回应 `prompt`（已接受），再去拉起 pi：控制面等回应只等 10 秒，冷启动（#539 第 9 题最慢 2.6 秒）加第一次调模型
 *   不能算在里面。拉起失败、写不了工作台上的 skill，这一轮以 `failed` 结束。
 * - 「可以打断助手」（#544）照协议（`@sfly/schema` 的 assistant-protocol.ts 文件头）做：一轮的四种状态（没有一轮、在做、在停止、
 *   在停止又有一轮在等）和每条命令在各状态下的回应；中止记号是只增不减的轮次；停止一轮（用户停止、到了上限、结束会话）
 *   从决定结束的那一刻起算，先 `clear_queue`、`abort`，等 `agent_settled`，等不到才结束进程；插话按交出的顺序认送到，
 *   没送到的在 `turn_end` 之前各发一条 `steer_dropped`。依赖 pi 的几条行为是 rpcprobe 第 11 到 17 题实测过的（evals/assistant）。
 * - 每一轮的上限在这里执行，模型够不着：{@link TURN_LIMITS}。到了就照「停止一轮」结束这一轮，以 `limit` 结束；会话还能接着说。
 * - 同时活着的 pi 进程数有上限（{@link MAX_PROCESSES}）。到了上限时，先关掉最久没用的**空闲**进程（关 stdin：
 *   它没有在做的一轮，#539 第 8 题）；没有空闲的就拒绝（503 `process_limit`，控制面把这一轮记成 `failed`）。
 *   为了回收而关 stdin 只对空闲的进程做（一轮进行中关了，pi 不等这一轮做完）。
 * - 保密环境变量的值在发出事件、写下 pi 的原始事件、写日志之前按值打码（redact.ts）。
 */

export const TURN_LIMITS = {
	/** 一轮最多调用模型的次数（数 pi 的 `turn_start`，第 41 次之前结束）。 */
	modelCalls: 40,
	/** 一轮最长的时间。 */
	durationMs: 20 * 60 * 1000,
} as const;

/**
 * 同时活着的 pi 进程数的上限：带产品的远程工具扩展，一个空闲的 pi 进程常驻约 141 MiB，一轮里的峰值约 162 MiB
 * （rpcprobe 第 9 题，假的模型端点、很短的一轮，是下限），8 个约 1.3 GiB；助手容器的内存上限定 2 GiB，
 * 给助手服务自己和打包、读写留出余量。
 */
export const MAX_PROCESSES = 8;

/**
 * 中止记号（协议「一轮的状态」）：每个会话一个只增不减的轮次，轮次不大于它的 `prompt` 都以 `stopped` 结束。十分钟没有被提高就过期，
 * 同时记着记号的会话数有上限（满了丢最早的）：过期和上限只为不让记号无限增长。
 */
export const ABORT_MARK_TTL_MS = 10 * 60 * 1000;
export const ABORT_MARK_LIMIT = 1000;

/** 模型没给超时的命令用多少秒：和一轮的时间上限一样（到了上限这一轮反正要结束）。 */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = TURN_LIMITS.durationMs / 1000;

export interface SessionManagerOptions {
	dataDir: string;
	modelsFile: string;
	model: string | undefined;
	/** `[node, <pi 的命令行入口>]`；测试里换成假的 pi。 */
	piArgv: string[];
	extension: string;
	skillsDir: string;
	hostEnv: NodeJS.ProcessEnv;
	bus: EventBus;
	/** 连到一台 Agent 的能力端口；`log` 是认不出的错误的原文的去处（带工作台的地址）。 */
	connect: (address: string, log?: (line: string) => void) => AgentClient;
	/** 助手服务的日志。写进去的原文（上游的错误、连接上的报错）先经 `#forLog`。 */
	log: (message: string) => void;
	limits?: { modelCalls: number; durationMs: number };
	maxProcesses?: number;
	/** 结束进程的宽限，默认协议的 `ASSISTANT_PROCESS_KILL_GRACE_MS`。 */
	killGraceMs?: number;
	/** 停止一轮时等 `agent_settled` 的时间，默认协议的 `ASSISTANT_ABORT_SETTLE_MS`。 */
	abortSettleMs?: number;
	/** 停止一轮的硬上限，默认协议的 `ASSISTANT_STOP_WAIT_MS`。 */
	stopWaitMs?: number;
	/** 计时（测试里换成手动推进的时钟）。 */
	clock?: Clock;
	/**
	 * pi 进程的临时目录建在这下面（每个进程一个，`TMPDIR`），默认容器自己的临时目录下的 `sfly-assistant-<数据目录的哈希>/`：
	 * 截断输出的全文按「两边路径相同」传到工作台上同一个路径，工作台上 `/tmp` 一定在、谁都能写；它也不该占数据卷。
	 * 按数据目录分开：本机起两个助手服务时，后起的启动清理不删先起的那个的；同一个数据目录重启后认得出上次留下的。
	 * 哈希按数据目录的绝对路径算，不解析符号链接：经符号链接和经真实路径起会算出两个目录；容器里数据目录固定（`/data`），
	 * 不会这样。
	 */
	tmpRoot?: string;
}

/** 助手服务结束这一轮的结局（停止、上限、结束会话、探不通工作台、等不到旧的进程……）。 */
interface Ending {
	outcome: TurnOutcome;
	reason: string;
	limit?: TurnLimit;
	errorClass?: ErrorClass;
}

/** 一轮「在停止」（协议「停止一轮」）：从决定结束的那一刻（T0）起的几样东西。 */
interface Stopping {
	ending: Ending;
	/** T0：决定结束这一轮的那一刻（助手服务自己的时钟）。 */
	t0: number;
	/** `clear_queue` 回应了（这之后还在 pi 队列里的插话是确定没送到的）。 */
	cleared: boolean;
	/** 等不到 `agent_settled`，开始结束 pi 进程了。 */
	killing: boolean;
	/** T0 加等 `agent_settled` 的时间、T0 加硬上限。 */
	timers: Timer[];
	/** 收到了 `end`：这一轮的 `turn_end` 发出之后关闭 pi 进程。 */
	closeAfter: boolean;
}

interface Turn {
	number: number;
	startedAt: number;
	body: PromptCommandBody;
	translator: TurnTranslator;
	/** 用时的上限。 */
	timer: Timer | undefined;
	/** 这一轮的插话（steers.ts）。 */
	steers: SteerBook;
	/** 这一轮的 `prompt` 写给了 pi：停止时要 `clear_queue`、`abort`。 */
	prompted: boolean;
	/** pi 接受了 `prompt`：之后的插话直接交给 pi，之前收下的按收到的顺序交出去。 */
	accepted: boolean;
	/** 这一轮自己的 `prompt` 那条用户消息出现过了（之后的用户消息才是插话送到）。 */
	promptSeen: boolean;
	/** pi 报告过 `agent_settled`：没有东西在跑。 */
	settledByPi: boolean;
	/** 「在停止」：见 {@link Stopping}。 */
	stop: Stopping | undefined;
	ended: boolean;
	/** 这一轮的工作台（能力端口的地址）：工具结果说工作台连不上时，助手服务自己探它。 */
	address: string;
	/** 这一轮的工作台的名字：给人看的原因里写它，不写地址。 */
	workbenchName: string;
	/** 正在探工作台（不重复探）。 */
	probing: boolean;
	/** 探的时候 pi 报告停下来了：探完再定结局。 */
	settled: Record<string, unknown> | undefined;
}

interface Session {
	id: string;
	dir: string;
	redactor: Redactor;
	process: PiProcess | undefined;
	/** 这个进程是按哪个工作台、哪个工作区起的：换了就重起。 */
	startedFor: { workbench: string; workdir: string } | undefined;
	/** 被关掉的进程退出之前：新进程等它。 */
	closing: Promise<void> | undefined;
	/** SIGKILL 之后还没退出、不再复用的旧进程（硬上限到了的那一轮的）：之后的一轮等它退出再起新的。 */
	stuck: PiProcess | undefined;
	/** 现在这个 pi 进程的临时目录（`TMPDIR`）。 */
	tmpDir: string | undefined;
	/** 「在做」的一轮（协议「一轮的状态」）；{@link stopping} 也在时它是「在等」的第 k 轮，还没开始。 */
	turn: Turn | undefined;
	/** 「在停止」的一轮（第 m 轮）。 */
	stopping: Turn | undefined;
	lastActive: number;
}

export type CommandResult =
	| { ok: true }
	| { ok: false; status: number; code: AssistantErrorCode; message: string };

/** @deprecated 叫 {@link CommandResult}。 */
export type PromptResult = CommandResult;

export class SessionManager {
	readonly #sessions = new Map<string, Session>();
	readonly #limits: { modelCalls: number; durationMs: number };
	readonly #maxProcesses: number;
	readonly #clock: Clock;
	readonly #settleMs: number;
	readonly #stopWaitMs: number;
	/** 正在关的 pi 进程（关 stdin 之后、退出之前）。 */
	readonly #closing = new Set<PiProcess>();
	/** 中止记号：会话 ID → 中止到第几轮（见 {@link abort}）。按最近一次提高的先后排，满了丢最早的。 */
	readonly #abortMarks = new Map<string, { turn: number; at: number }>();

	/** 模型文件引用的环境变量的值（模型的密钥）：写日志时也打码。第一次用到时读。 */
	#modelSecrets: Redactor | undefined;

	constructor(private readonly options: SessionManagerOptions) {
		this.#limits = options.limits ?? TURN_LIMITS;
		this.#maxProcesses = options.maxProcesses ?? MAX_PROCESSES;
		this.#clock = options.clock ?? realClock;
		this.#settleMs = options.abortSettleMs ?? ASSISTANT_ABORT_SETTLE_MS;
		this.#stopWaitMs = options.stopWaitMs ?? ASSISTANT_STOP_WAIT_MS;
		mkdirSync(join(options.dataDir, "sessions"), { recursive: true });
		this.#cleanLeftovers();
	}

	/**
	 * 上次（被强行结束时）留下的东西：每个 pi 进程的设置目录（里面有模型文件的副本）、每一轮的配置文件（里面有
	 * 保密值的原文）、pi 的临时目录。正常退出时这些都已经删了；被 SIGKILL、容器被杀时会留下，启动时清掉。
	 */
	#cleanLeftovers(): void {
		const { dataDir } = this.options;
		rmSync(join(dataDir, "agents"), { recursive: true, force: true });
		rmSync(this.tmpRoot, { recursive: true, force: true });
		for (const id of readdirSync(join(dataDir, "sessions"))) {
			rmSync(join(dataDir, "sessions", id, "turn.json"), { force: true });
		}
	}

	/**
	 * 一段原文（上游的错误、工作台连接上的报错）写进日志之前：按这个会话的保密值和模型文件引用的环境变量的值打码，
	 * 再按形状打码（`Authorization`、`Bearer`、地址里的用户名密码），截到上限（redact.ts 的 `forLog`）。
	 */
	#forLog(session: Session, text: string): string {
		if (!this.#modelSecrets) {
			this.#modelSecrets = new Redactor();
			try {
				const { names } = modelEnvRefs(readFileSync(this.options.modelsFile, "utf8"));
				this.#modelSecrets.add(names.map((name) => this.options.hostEnv[name] ?? ""));
			} catch {
				// 读不了模型文件（启动时已经检查过，这里不会发生）：只按形状打码。
			}
		}
		return forLog(text, [session.redactor, this.#modelSecrets]);
	}

	/** pi 进程的临时目录都在这下面（每个进程一个，`TMPDIR`）；见 {@link SessionManagerOptions.tmpRoot}。 */
	get tmpRoot(): string {
		if (this.options.tmpRoot) return this.options.tmpRoot;
		const instance = createHash("sha256").update(resolve(this.options.dataDir)).digest("hex");
		return join(tmpdir(), `sfly-assistant-${instance.slice(0, 12)}`);
	}

	/**
	 * 算进上限的 pi 进程：活着的、正在关的（被关掉的空闲进程退出之前），以及一轮已经开始、进程还在起的（占一个位置，
	 * 并发的几句话不会一起越过上限）。
	 */
	get activeProcesses(): number {
		let count = this.#closing.size;
		for (const s of this.#sessions.values()) {
			if (s.process ? !s.process.exited : s.turn && !s.turn.ended) count += 1;
		}
		return count;
	}

	get maxProcesses(): number {
		return this.#maxProcesses;
	}

	/**
	 * `POST /sessions/:id/prompt`（协议「`prompt` 的判断」，先后固定）：
	 * 1. 轮次不大于中止记号：202，以 `stopped` 结束，不起 pi；不改任何别的状态；
	 * 2. 这个会话有一轮「在做」（包括在等的第 k 轮）：409 `turn_running`；
	 * 3. 否则登记、202：没有一轮在停止就在后台开始；有的话等它的 `turn_end`（{@link #finish}）再开始。
	 * 503 只在登记之前决定（进程数满了）。
	 */
	prompt(sessionId: string, body: PromptCommandBody): CommandResult {
		const session = this.#session(sessionId);
		if (body.turn <= this.#mark(sessionId)) {
			const turn = this.#newTurn(session, body);
			this.options.log(
				`会话 ${session.id} 第 ${body.turn} 轮：到之前已经收到针对它的中止，直接结束`,
			);
			queueMicrotask(() =>
				this.#end(session, turn, { outcome: "stopped", reason: "这一轮到之前已经要求停止了" }),
			);
			return { ok: true };
		}
		if (session.turn) {
			return { ok: false, status: 409, code: "turn_running", message: "这个会话已有一轮在做" };
		}
		const needsProcess = !session.stopping && (!session.process || session.process.exited);
		if (needsProcess && this.activeProcesses >= this.#maxProcesses && !this.#evictIdle()) {
			return {
				ok: false,
				status: 503,
				code: "process_limit",
				message: `同时活着的 pi 进程已经有 ${this.#maxProcesses} 个，都在做`,
			};
		}
		session.redactor.add(Object.values(body.secret_env));
		if (!session.stopping) {
			// 登记之前写这一轮的配置：写不了就 503，这一轮没有登记。有一轮在停止时那一轮还在用它，开始时再写（#start）。
			try {
				this.#writeTurnConfig(session, body);
			} catch (error) {
				return {
					ok: false,
					status: 503,
					code: "start_failed",
					message: `写不了这一轮的配置：${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		const turn = this.#newTurn(session, body);
		session.turn = turn;
		session.lastActive = this.#clock.now();
		turn.timer = this.#clock.setTimeout(
			() =>
				this.#stop(session, turn, {
					outcome: "limit",
					reason: "这一轮用时到了上限",
					limit: "duration",
				}),
			this.#limits.durationMs,
		);
		if (session.stopping) {
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮：第 ${session.stopping.number} 轮还在停止，等它结束再开始`,
			);
		} else {
			void this.#start(session, turn, false);
		}
		return { ok: true };
	}

	#newTurn(session: Session, body: PromptCommandBody): Turn {
		return {
			number: body.turn,
			startedAt: this.#clock.now(),
			body,
			translator: new TurnTranslator(session.redactor),
			timer: undefined,
			steers: new SteerBook(),
			prompted: false,
			accepted: false,
			promptSeen: false,
			settledByPi: false,
			stop: undefined,
			ended: false,
			address: body.workbench.address,
			workbenchName: body.workbench.name,
			probing: false,
			settled: undefined,
		};
	}

	/**
	 * `POST /sessions/:id/steer`（协议「插话」）：只有第 `turn` 轮「在做」才收下（包括 pi 还没拿到 `prompt`、在等旧的一轮的时候：
	 * 先留着，`prompt` 交给 pi 之后按收到的顺序交出去），其余 409 `no_turn_running`。同一个 `message_id` 再来只算一次。
	 * 收下之后先发一份含它的 `steer_queue`。
	 */
	steer(sessionId: string, body: SteerCommandBody): CommandResult {
		const session = this.#sessions.get(sessionId);
		const turn = session?.turn;
		if (!session || !turn || turn.number !== body.turn || turn.stop || turn.ended) {
			return {
				ok: false,
				status: 409,
				code: "no_turn_running",
				message: `第 ${body.turn} 轮没有在做`,
			};
		}
		if (!turn.steers.accept(body.message_id, body.text)) return { ok: true };
		this.#emitQueue(session, turn);
		if (turn.accepted) this.#handOver(session, turn);
		return { ok: true };
	}

	/**
	 * `POST /sessions/:id/end`（协议「结束会话」）：收到就回（202），在后台按状态处理：没有一轮就关闭 pi 进程；有一轮在做就照
	 * 「停止一轮」结束它（`stopped`，会话结束了），`turn_end` 发出之后关闭进程；在停止的等它停完再关；在等的那一轮立即 `stopped`。
	 * 不动中止记号，不删任何东西；不记着收到过 `end`。不认识的会话什么也不做。
	 */
	end(sessionId: string): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		const ending: Ending = { outcome: "stopped", reason: "会话结束了" };
		if (session.stopping) {
			if (session.stopping.stop) session.stopping.stop.closeAfter = true;
			if (session.turn) this.#end(session, session.turn, ending);
			return;
		}
		const turn = session.turn;
		if (turn) {
			this.#stop(session, turn, ending);
			if (turn.stop && !turn.ended) {
				turn.stop.closeAfter = true;
				return;
			}
		}
		this.#close(session);
	}

	/** 中止记号：中止到第几轮（没有、过期了是 0）。 */
	#mark(sessionId: string): number {
		const mark = this.#abortMarks.get(sessionId);
		if (!mark) return 0;
		if (this.#clock.now() - mark.at > ABORT_MARK_TTL_MS) {
			this.#abortMarks.delete(sessionId);
			return 0;
		}
		return mark.turn;
	}

	/** 把记号提到 `turn`：只增不减（已经不小于它时不变，也不刷新过期）；总数有上限（满了丢最早的）。 */
	#raiseMark(sessionId: string, turn: number): void {
		if (this.#mark(sessionId) >= turn) return;
		this.#abortMarks.delete(sessionId);
		this.#abortMarks.set(sessionId, { turn, at: this.#clock.now() });
		while (this.#abortMarks.size > ABORT_MARK_LIMIT) {
			const oldest = this.#abortMarks.keys().next().value as string;
			this.#abortMarks.delete(oldest);
		}
	}

	/** 现在留着的记号数（测试用）。 */
	get abortMarks(): number {
		return this.#abortMarks.size;
	}

	/** 这个会话现在的 pi 进程号（诊断和测试用）；没有活着的进程时 undefined。 */
	pid(sessionId: string): number | undefined {
		const process = this.#sessions.get(sessionId)?.process;
		return process && !process.exited ? process.pid : undefined;
	}

	/**
	 * `POST /sessions/:id/abort`（协议「一轮的状态」的 `abort` 一列）：先把中止记号提到 `turn`（之后轮次不大于它的 `prompt`
	 * 都以 `stopped` 结束），再看状态：在做的一轮轮次不大于 `turn` 就照「停止一轮」结束它；在等的第 k 轮轮次不大于 `turn` 就
	 * **立即**以 `stopped` 结束（不起 pi）；在停止的照常停止；轮次比 `turn` 大的不动。重复调用无害。
	 */
	abort(sessionId: string, turn: number): void {
		this.#raiseMark(sessionId, turn);
		const session = this.#sessions.get(sessionId);
		const current = session?.turn;
		if (!session || !current || current.number > turn) return;
		const ending: Ending = { outcome: "stopped", reason: "用户停止了这一轮" };
		if (session.stopping) this.#end(session, current, ending);
		else this.#stop(session, current, ending);
	}

	/** 助手服务退出：在做的、在停止的一轮都以 `interrupted` 结束，直接结束全部 pi 进程（不等 `abort`）。 */
	async shutdown(): Promise<void> {
		const ending: Ending = { outcome: "interrupted", reason: "助手服务停止了" };
		for (const session of this.#sessions.values()) {
			if (session.stopping && session.turn) this.#end(session, session.turn, ending);
			const active = session.stopping ?? session.turn;
			if (!active || active.ended) continue;
			if (!active.stop) this.#beginStop(session, active, ending);
			if (!session.process || session.process.exited) this.#finish(session, active);
		}
		await Promise.all([
			...[...this.#sessions.values()].map((session) => session.process?.terminate()),
			...[...this.#closing].map((process) => process.terminate()),
		]);
	}

	#session(id: string): Session {
		let session = this.#sessions.get(id);
		if (!session) {
			const dir = join(this.options.dataDir, "sessions", id);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			session = {
				id,
				dir,
				redactor: new Redactor(),
				process: undefined,
				startedFor: undefined,
				closing: undefined,
				tmpDir: undefined,
				turn: undefined,
				stopping: undefined,
				stuck: undefined,
				lastActive: this.#clock.now(),
			};
			this.#sessions.set(id, session);
		}
		return session;
	}

	/** `workdir`：这一轮的工作区。pi 在助手容器里同一个路径下运行，skill 也放在同一个位置（两边路径相同）。 */
	#paths(session: Session, workdir = ""): LaunchPaths {
		return {
			sessionDir: session.dir,
			cwd: workdir,
			skillsDir: workbenchSkillsDir(workdir),
			extension: this.options.extension,
			turnConfig: join(session.dir, "turn.json"),
			contextFile: join(session.dir, "context.md"),
		};
	}

	/** 这一轮交给扩展的配置：只有属主可读，这一轮结束时删掉。 */
	#writeTurnConfig(session: Session, body: PromptCommandBody): void {
		const config: TurnConfig = {
			address: body.workbench.address,
			workdir: body.workbench.workdir,
			env: { ...body.env, ...body.secret_env },
			defaultTimeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
			secrets: session.redactor.values,
		};
		const path = this.#paths(session).turnConfig;
		rmSync(path, { force: true });
		writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
	}

	/**
	 * 开始这一轮：写这一轮的配置、准备进程（换了工作台或工作区就关掉重起；没有活着的就写 skill、起进程，插话设成「一次全送」）、
	 * 交 `prompt`。进程留着（上一轮 `abort` 之后、或者正常做完）时，交 `prompt` 之前先 `clear_queue` 一次：上一轮停止时
	 * 晚进队列的插话不会被这一轮送给模型（协议「停止一轮」，rpcprobe 第 13 题）。每一步之前看这一轮是不是已经被结束了。
	 */
	async #start(session: Session, turn: Turn, writeConfig: boolean): Promise<void> {
		const body = turn.body;
		const wanted = { workbench: body.workbench.name, workdir: body.workbench.workdir };
		let spawned = false;
		try {
			if (writeConfig) this.#writeTurnConfig(session, body);
			if (
				session.process &&
				!session.process.exited &&
				(session.startedFor?.workbench !== wanted.workbench ||
					session.startedFor?.workdir !== wanted.workdir)
			) {
				// 换了工作台或工作区：工具和系统提示里的路径是启动时定的，空闲的进程关掉重起。
				this.#close(session);
			}
			// 被关掉的进程退出之前不起新的：两个 pi 不同时写同一个会话文件。SIGKILL 之后还没退出的旧进程最多等
			// ASSISTANT_STOP_WAIT_MS，等不到这一轮以 failed 结束（和在停止的一轮后面等的那一轮同一个说法）。
			const stuck = session.stuck;
			if (stuck && !stuck.exited) {
				let timer: Timer | undefined;
				const gaveUp = await Promise.race([
					stuck.wait().then(() => false),
					new Promise<boolean>((resolve) => {
						timer = this.#clock.setTimeout(() => resolve(true), this.#stopWaitMs);
					}),
				]);
				this.#clock.clearTimeout(timer);
				if (turn.ended || turn.stop) return;
				if (gaveUp) {
					this.#end(session, turn, {
						outcome: "failed",
						reason: "上一轮的 pi 进程没有退出，所以这一轮没有开始",
					});
					return;
				}
			}
			await session.closing;
			if (turn.ended || turn.stop) return;
			if (!session.process || session.process.exited) {
				const { name, address } = body.workbench;
				const agent = this.options.connect(address, (line) =>
					this.options.log(
						`会话 ${session.id} 第 ${turn.number} 轮：${this.#forLog(session, line)}`,
					),
				);
				try {
					await writeSkillsToWorkbench(agent, this.options.skillsDir, body.workbench.workdir);
				} catch (error) {
					// 原因里写工作台的名字（#640）；工作台这条连接上的错误已经换成能给人看的（agent.ts），别的不放行原文。
					const why =
						error instanceof WorkbenchError ? error.message : "助手服务内部出错（原文记在日志里）";
					throw new StartError(`往工作台 ${name} 上写 skill 失败：${why}`, error);
				} finally {
					agent.close();
				}
				if (turn.ended || turn.stop) return;
				this.#spawn(session, wanted);
				spawned = true;
				// 连着发的几句插话一次送完（协议「插话」，rpcprobe 第 14 题）。
				const mode = await session.process?.request({ type: "set_steering_mode", mode: "all" });
				// 写不进去（进程没了）不记：读着像 pi 拒绝了；进程退出的那条路自己会记、会收尾。
				if (mode && mode.success !== true && mode.gone !== true) {
					this.options.log(
						`会话 ${session.id}：设插话的模式失败：${this.#forLog(session, String(mode.error ?? ""))}`,
					);
				}
			} else {
				const cleared = await session.process.request({ type: "clear_queue" });
				const left = queued(cleared);
				if (left > 0) {
					this.options.log(
						`会话 ${session.id} 第 ${turn.number} 轮：交 prompt 之前 pi 的队列里还有 ${left} 句（上一轮停止时晚进队列的），丢掉`,
					);
				}
			}
			const process = session.process;
			if (!process || process.exited || turn.ended || turn.stop) return;
			turn.prompted = true;
			const response = await process.request({ type: "prompt", message: body.text });
			if (spawned) {
				// 冷启动：从收到这句话到新起的 pi 接受它（写 skill、起进程、加载扩展、恢复会话）。
				this.options.log(
					`会话 ${session.id} 第 ${turn.number} 轮：新起的 pi 接受了这句话，冷启动 ${this.#clock.now() - turn.startedAt} 毫秒`,
				);
			}
			// 进程没了（写不进去、已经退出）：这一轮按进程退出的那条路收尾（interrupted）。
			if (turn.ended || response.gone === true) return;
			if (response.success !== true) {
				// 停止时 pi 恰好拒绝了这句话：pi 是空闲的，不用等 agent_settled、更不用结束进程，直接发结局。已经在结束进程
				// （等 agent_settled 超时、SIGTERM 发了）时不走这里：这一轮等进程退出时结束，在等的下一轮等它退出再开始（#677 复审）。
				// 等回应的时候这一轮可能已经进了停止（上面的判断在 await 之前，类型收窄不知道它会变）。
				const stop = turn.stop as Stopping | undefined;
				if (stop) {
					if (!stop.killing) this.#finish(session, turn);
					return;
				}
				this.#end(session, turn, {
					outcome: "failed",
					reason: `pi 没有接受这句话：${session.redactor.redact(String(response.error ?? ""))}`,
				});
				return;
			}
			turn.accepted = true;
			if (!turn.stop) this.#handOver(session, turn);
		} catch (error) {
			if (turn.ended) return;
			const raw = error instanceof StartError ? error.cause : error;
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮开始失败（工作台 ${body.workbench.name}，${body.workbench.address}）：${this.#forLog(session, raw instanceof Error ? raw.message : String(raw))}`,
			);
			if (turn.stop) {
				if (!turn.stop.killing) this.#finish(session, turn);
				return;
			}
			// 认得的才放行（#640）：写 skill 的那一步换好了说法（StartError），别的步骤（建工作区、镜像 skill、准备启动、
			// 给 pi 发请求）的原文是助手容器本机的错误、带容器里的路径，只进上面的日志。
			const shown =
				error instanceof StartError ? error.message : "助手服务内部出错（原文记在日志里）";
			this.#end(session, turn, {
				outcome: "failed",
				reason: `开始这一轮失败：${session.redactor.redact(shown)}`,
			});
		}
	}

	#spawn(session: Session, startedFor: { workbench: string; workdir: string }): void {
		const paths = this.#paths(session, startedFor.workdir);
		// 两边路径相同：助手容器里建同一个工作区（空的，镜像里有 /work），skill 放进同一个位置。
		mkdirSync(startedFor.workdir, { recursive: true });
		mirrorSkillsLocally(this.options.skillsDir, startedFor.workdir);
		writeContextFile(paths.contextFile, startedFor.workbench, startedFor.workdir);
		const launch = prepareLaunch({
			sessionId: session.id,
			paths,
			dataDir: this.options.dataDir,
			modelsFile: this.options.modelsFile,
			model: this.options.model,
			piArgv: this.options.piArgv,
			hostEnv: this.options.hostEnv,
			tmpRoot: this.tmpRoot,
		});
		session.startedFor = startedFor;
		session.tmpDir = launch.tmpDir;
		// pi 原始事件的副本（打过码，排查用）：异步写，`turn_end` 不等它落盘（#684）。它不在协议里、没有谁据它做决定，
		// 等它会让每一轮的结局多一次磁盘往返、多一种失败；要读它的（测试、排查）等它写完再读。
		const raw = createWriteStream(join(session.dir, "events.jsonl"), { flags: "a", mode: 0o600 });
		raw.on("error", (error) =>
			this.options.log(`会话 ${session.id}：写 events.jsonl 失败：${describeError(error)}`),
		);
		const stderr = session.redactor.stream();
		const process = new PiProcess({
			argv: launch.argv,
			cwd: launch.cwd,
			env: launch.env,
			stderrPath: join(session.dir, "pi-stderr.log"),
			// pi 的标准错误也是日志：写下之前打码。
			filterStderr: { push: (text) => stderr.push(text), flush: () => stderr.flush() },
			onStderrError: (error) =>
				this.options.log(`会话 ${session.id}：写 pi-stderr.log 失败：${describeError(error)}`),
			killGraceMs: this.options.killGraceMs,
			clock: this.#clock,
			onRecord: (record, line) => {
				// 命令输出的每一次更新都是到这一刻为止的全部输出：不再整份存一遍（工具结束时的结果里有）。
				if (record?.type !== "tool_execution_update") {
					raw.write(`${session.redactor.redact(line)}\n`);
				}
				this.#onRecord(session, process, record);
			},
			onExit: (code, signal) => {
				raw.end();
				// 这次启动新建的设置目录、临时目录用完就删（不和别的进程、别的会话共用）。
				rmSync(launch.agentDir, { recursive: true, force: true });
				rmSync(launch.tmpDir, { recursive: true, force: true });
				this.#onExit(session, process, code, signal);
			},
		});
		session.process = process;
	}

	/** 这一轮收下、还没交给 pi 的插话按收到的顺序交出去（写 `steer`），各自的回应到了再看 `disposition`。 */
	#handOver(session: Session, turn: Turn): void {
		const process = session.process;
		if (!process || process.exited) return;
		for (const steer of turn.steers.takeHeld()) {
			void process
				.request({ type: "steer", message: steer.text })
				.then((response) => this.#onSteerResponse(session, turn, steer, response));
		}
	}

	/**
	 * pi 对 `steer` 的回应：`disposition` 是 `queued` 才算进了队列。`handled`（被扩展的输入处理器吃掉了，不进队列、不会有用户消息，
	 * rpcprobe 第 16 题）和别的（回应失败、没说进了队列）都当作没送到：先发它的 `steer_dropped`，再发不含它的 `steer_queue`。
	 */
	#onSteerResponse(
		session: Session,
		turn: Turn,
		steer: Steer,
		response: Record<string, unknown>,
	): void {
		// 进程没了（写不进去、已经退出）：这一轮按进程退出的那条路收尾，这句话在那里写「没有确认送到」。
		if (turn.ended || response.gone === true) return;
		const disposition = (response.data as { disposition?: unknown } | undefined)?.disposition;
		if (response.success === true && disposition === "queued") return;
		const dropped = turn.steers.drop(steer.messageId);
		if (!dropped) return;
		this.#emitDropped(
			session,
			turn,
			dropped,
			disposition === "handled" ? "被扩展处理了，没有送到模型" : "pi 没有收下，没有送到",
		);
		this.#emitQueue(session, turn);
	}

	#onRecord(
		session: Session,
		process: PiProcess,
		record: Record<string, unknown> | undefined,
	): void {
		// pi 此刻在做的一轮：有一轮在停止就是它（在等的那一轮还没交给 pi），否则是在做的那一轮。
		const turn = session.stopping ?? session.turn;
		if (!record || !turn || turn.ended || session.process !== process) return;
		if (record.type === "agent_settled") turn.settledByPi = true;
		const userMessage =
			record.type === "message_end" &&
			(record.message as { role?: unknown } | undefined)?.role === "user";
		if (turn.stop) {
			// 在停止：pi 还在吐的事件不外传；插话的记录照常更新（哪几句送到了，停下之后要用），`steer_queue` 不再发。
			if (userMessage) this.#delivered(session, turn);
			if (record.type === "agent_settled" && !turn.stop.killing) this.#finish(session, turn);
			return;
		}
		const { events, unknown, upstreamError, compactionError } = turn.translator.translate(record);
		if (unknown) this.options.log(`会话 ${session.id}：认不出的 pi 事件 ${unknown}`);
		if (upstreamError !== undefined) {
			// 上游的错误原文只进日志：事件里是助手服务自己的说法（#640）。
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮：上游模型出错：${this.#forLog(session, upstreamError)}`,
			);
		}
		if (compactionError !== undefined) {
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮：压缩上下文失败：${this.#forLog(session, compactionError)}`,
			);
		}
		for (const event of events) this.#emit(session, turn, event);
		if (userMessage && this.#delivered(session, turn)) this.#emitQueue(session, turn);
		const unreachable = workbenchUnreachable(record);
		if (unreachable !== undefined && !turn.probing) {
			// 工具结果里有「工作台连不上」：可能是扩展写的，也可能是命令自己打出来的、读到的文件路径里带的。只看文字定不下来，
			// 助手服务自己探一次这一轮的工作台：探不通才不等到上限、以失败结束这一轮；探得通就是普通的工具错误，照常往下走。
			turn.probing = true;
			const name = turn.workbenchName;
			const probe = this.options.connect(turn.address);
			void probe.reachable().then((ok) => {
				// 探完就关：每探一次是一条新连接，留着它会空闲 15 分钟、其间一直 ping。
				probe.close();
				turn.probing = false;
				const settled = turn.settled;
				turn.settled = undefined;
				if (turn.ended || turn.stop) return;
				if (!ok) {
					// 原因用助手服务自己的说法：工具结果里那一行可能是命令自己的输出。
					this.#stop(session, turn, {
						outcome: "failed",
						// 写工作台的名字，不写它能力端口的内部地址（#640）。
						reason: `${WORKBENCH_UNREACHABLE}：${name}（工具报了连不上，助手服务又探了一次，还是连不上）`,
					});
				} else if (settled) {
					this.#settle(session, turn, settled);
				}
			});
		}
		if (record.type === "turn_start" && turn.translator.modelCalls > this.#limits.modelCalls) {
			this.#stop(session, turn, {
				outcome: "limit",
				reason: `这一轮调用模型到了 ${this.#limits.modelCalls} 次的上限`,
				limit: "model_calls",
			});
			return;
		}
		if (record.type === "agent_settled") {
			// 还在探工作台：等探完再定结局（探不通是「工作台连不上」，不是做完了）。
			if (turn.probing) {
				turn.settled = record;
				return;
			}
			this.#settle(session, turn, record);
		}
	}

	/**
	 * pi 出现了一条用户消息：这一轮的第一条是它自己的 `prompt`，之后的每一条按交出的顺序对上一句插话，算送到
	 * （协议「怎么认『送到』」，rpcprobe 第 15、17 题：一轮里别的用户消息只有插话，连发的两句各一条）。
	 */
	#delivered(session: Session, turn: Turn): boolean {
		if (!turn.promptSeen) {
			turn.promptSeen = true;
			return false;
		}
		if (turn.steers.deliverNext()) return true;
		this.options.log(
			`会话 ${session.id} 第 ${turn.number} 轮：pi 出现了一条用户消息，但没有交出去还没送到的插话`,
		);
		return false;
	}

	/** pi 报告这一轮停下来了（`agent_settled`）：定结局。 */
	#settle(session: Session, turn: Turn, record: Record<string, unknown>): void {
		const t = turn.translator;
		if (record.aborted === true) {
			this.#end(session, turn, { outcome: "stopped", reason: "这一轮被中止了" });
		} else if (t.retriesExhausted !== undefined || t.lastModelError !== undefined) {
			const error = (t.retriesExhausted ?? t.lastModelError) as UpstreamError;
			// 原因不带「模型不可用」：页面按结局加这个前缀（和「出错」「中断」一样）。
			this.#end(session, turn, {
				outcome: "model_unavailable",
				reason: error.text,
				errorClass: error.errorClass,
			});
		} else {
			this.#end(session, turn, { outcome: "completed", reason: "这一轮做完了" });
		}
	}

	#onExit(
		session: Session,
		process: PiProcess,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		this.#closing.delete(process);
		// 被关掉的进程（空闲、换了工作区）退出：和这个会话现在的一轮无关。
		if (session.process !== process) return;
		session.process = undefined;
		if (session.stopping && !session.stopping.ended) {
			this.#finish(session, session.stopping);
			return;
		}
		const turn = session.turn;
		if (!turn || turn.ended) return;
		const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
		this.options.log(`会话 ${session.id} 第 ${turn.number} 轮里 pi 进程退出了（${how}）`);
		this.#end(session, turn, {
			outcome: "interrupted",
			reason: `pi 进程在这一轮里退出了（${how}）`,
		});
	}

	/** 这一轮进入「在停止」（T0 是此刻）：在做的那一轮挪到 {@link Session.stopping}。 */
	#beginStop(session: Session, turn: Turn, ending: Ending): Stopping {
		const stop: Stopping = {
			ending,
			t0: this.#clock.now(),
			cleared: false,
			killing: false,
			timers: [],
			closeAfter: false,
		};
		turn.stop = stop;
		this.#clock.clearTimeout(turn.timer);
		if (session.turn === turn) {
			session.turn = undefined;
			session.stopping = turn;
		}
		return stop;
	}

	/**
	 * 停止一轮（协议「停止一轮」）：用户停止、到了上限、结束会话、探不通工作台走同一条路，计时都从 T0（此刻）起算。
	 * - 这一轮还没把 `prompt` 交给 pi（在起进程、准备 skill），或者 pi 已经报告过 `agent_settled`：不写什么，直接发结局，进程留着；
	 * - 否则接连写 `clear_queue` 和 `abort`（不等前一条的回应，先清队列：`abort` 之后留在队列里的插话还会被处理）；
	 *   T0 加 {@link ASSISTANT_ABORT_SETTLE_MS} 之内 pi 报告了 `agent_settled` 就发结局、进程留着，下一轮接着用（rpcprobe 第 11 题）；
	 *   没等到就结束进程（关 stdin、SIGTERM，宽限之后 SIGKILL），退出之后发结局；
	 * - 硬上限：T0 加 {@link ASSISTANT_STOP_WAIT_MS} 还没发结局（进程在 SIGKILL 之后也没退出）就照样发。
	 */
	#stop(session: Session, turn: Turn, ending: Ending): void {
		if (turn.ended || turn.stop) return;
		const stop = this.#beginStop(session, turn, ending);
		const process = session.process;
		if (!turn.prompted || turn.settledByPi || !process || process.exited) {
			this.#finish(session, turn);
			return;
		}
		void process.request({ type: "clear_queue" }).then((response) => {
			if (response.success !== true) return;
			stop.cleared = true;
			// 取回了 k 句：交出去、还没送到的前 k 句没有送到（pi 的队列先进先出），之后的用户消息从第 k+1 句开始对。
			const left = queued(response);
			const marked = turn.steers.clearFirst(left);
			if (marked !== left) {
				this.options.log(
					`会话 ${session.id} 第 ${turn.number} 轮：clear_queue 取回 ${left} 句，按记录交出去还没送到的只有 ${marked} 句`,
				);
			}
		});
		void process.request({ type: "abort" });
		stop.timers.push(
			this.#clock.setTimeout(() => this.#kill(session, turn), this.#settleMs),
			this.#clock.setTimeout(() => this.#finish(session, turn), this.#stopWaitMs),
		);
	}

	/** 等不到 `agent_settled`：结束 pi 进程（退出之后 {@link #onExit} 发结局）。 */
	#kill(session: Session, turn: Turn): void {
		if (turn.ended || !turn.stop) return;
		turn.stop.killing = true;
		const process = session.process;
		this.options.log(
			`会话 ${session.id} 第 ${turn.number} 轮：停止之后 ${this.#settleMs} 毫秒没有等到 pi 停下，结束 pi 进程`,
		);
		if (process && !process.exited) void process.terminate();
		else this.#finish(session, turn);
	}

	/**
	 * 在停止的一轮发结局（协议「停止一轮」第 4、5 步：没送到的插话各一条 `steer_dropped`，再 `turn_end`），然后：收到过 `end` 的
	 * 关闭进程；有一轮在等的开始它；进程在 SIGKILL 之后还没退出（硬上限到了）时，在等的那一轮以 `failed` 结束。
	 */
	#finish(session: Session, turn: Turn): void {
		const stop = turn.stop;
		if (turn.ended || !stop) return;
		for (const timer of stop.timers) this.#clock.clearTimeout(timer);
		const stuck = stop.killing && session.process !== undefined && !session.process.exited;
		if (stuck) {
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮：SIGKILL 之后 pi 进程还没有退出，到了 ${this.#stopWaitMs} 毫秒照样结束这一轮`,
			);
		}
		if (stuck && session.process) {
			// SIGKILL 之后还没退出的进程不再复用：挪到「正在关」里，算进上限；之后的一轮等它退出（#start）。
			const process = session.process;
			session.process = undefined;
			this.#closing.add(process);
			session.stuck = process;
			session.closing = process.wait().finally(() => {
				if (session.stuck === process) session.stuck = undefined;
			});
		}
		this.#end(session, turn, stop.ending);
		if (stop.closeAfter && !stuck) this.#close(session);
		const next = session.turn;
		if (!next || next.ended) return;
		if (stuck) {
			this.#end(session, next, {
				outcome: "failed",
				reason: `上一轮（第 ${turn.number} 轮）的 pi 进程没有退出，所以这一轮没有开始`,
			});
			return;
		}
		void this.#start(session, next, true);
	}

	#end(session: Session, turn: Turn, end: Ending): void {
		if (turn.ended) return;
		turn.ended = true;
		this.#clock.clearTimeout(turn.timer);
		for (const timer of turn.stop?.timers ?? []) this.#clock.clearTimeout(timer);
		// 不变式：每句收下的插话在 `turn_end` 之前要么送到了，要么有它的 `steer_dropped`（协议「插话」）。
		// 交给了 pi、pi 停下或者清过队列之后还没送到的是确定没送到；进程没了、结局之前没等到的只能说没有确认送到。
		const sure = turn.settledByPi || turn.stop?.cleared === true;
		for (const steer of turn.steers.dropRest()) {
			const confirmed = steer.state === "held" || steer.state === "cleared" || sure;
			this.#emitDropped(session, turn, steer, confirmed ? "没有送到" : "没有确认送到");
		}
		const t = turn.translator;
		this.#emit(session, turn, {
			type: "turn_end",
			turn: turn.number,
			outcome: end.outcome,
			reason: end.reason,
			steps: t.steps,
			// 到了模型调用的上限时，第 41 次 `turn_start` 之后就结束了，那一次没有调出去。
			model_calls: end.limit === "model_calls" ? t.modelCalls - 1 : t.modelCalls,
			duration_ms: this.#clock.now() - turn.startedAt,
			usage: t.usage,
			...(end.limit && { limit_kind: end.limit }),
			...(end.errorClass && { error_class: end.errorClass }),
		});
		if (session.turn === turn) session.turn = undefined;
		if (session.stopping === turn) session.stopping = undefined;
		// 撞上记号直接结束的、在等就被结束的那一轮没用过配置和临时文件：别的一轮还在的话留给它。
		if (!session.turn && !session.stopping) {
			try {
				rmSync(this.#paths(session).turnConfig, { force: true });
			} catch (error) {
				this.options.log(`会话 ${session.id}：删这一轮的配置失败：${(error as Error).message}`);
			}
			// 这一轮命令的完整输出已经传到工作台上了：助手容器里的临时文件清掉（不占所有会话共用的磁盘）。
			if (session.tmpDir) emptyDir(session.tmpDir);
		}
		session.lastActive = this.#clock.now();
	}

	#emit(session: Session, turn: Turn, event: AssistantEvent): void {
		// 先打码，再把 NUL 和不成对的代理字符换掉（控制面的数据库存不进去，存不进去这条事件就丢了）。
		this.options.bus.emit(session.id, turn.number, storable(session.redactor.redactValue(event)));
	}

	/** 还没送到的插话的完整列表（每次变化发一条）；决定结束这一轮之后不再发。 */
	#emitQueue(session: Session, turn: Turn): void {
		if (turn.stop || turn.ended) return;
		this.#emit(session, turn, { type: "steer_queue", messages: turn.steers.pending() });
	}

	#emitDropped(session: Session, turn: Turn, steer: Steer, why: string): void {
		this.#emit(session, turn, {
			type: "notice",
			kind: "steer_dropped",
			message: `插话「${quote(steer.text)}」${why}`,
			message_id: steer.messageId,
		});
	}

	/** 关掉最久没用的空闲 pi 进程（没有在做、在停止的一轮，关 stdin 安全）；关了一个返回 true。 */
	#evictIdle(): boolean {
		const idle = [...this.#sessions.values()]
			.filter((s) => s.process && !s.process.exited && !s.turn && !s.stopping)
			.sort((a, b) => a.lastActive - b.lastActive)[0];
		if (!idle?.process) return false;
		this.#close(idle);
		return true;
	}

	/**
	 * 关掉这个会话的 pi 进程：**只用于空闲的进程**（关 stdin，#539 第 8 题；宽限之后 SIGKILL）；它不再是这个会话的进程，
	 * 退出之前算进上限。
	 */
	#close(session: Session): void {
		const process = session.process;
		if (!process || process.exited) return;
		session.process = undefined;
		this.#closing.add(process);
		const closed = process.close(this.options.killGraceMs ?? KILL_GRACE_MS);
		session.closing = closed.finally(() => {
			if (session.closing === closed) session.closing = undefined;
		});
	}
}

/** `clear_queue` 的回应里取回了几句（插话和 follow-up）。 */
function queued(response: Record<string, unknown>): number {
	const data = response.data as { steering?: unknown[]; followUp?: unknown[] } | undefined;
	return (data?.steering?.length ?? 0) + (data?.followUp?.length ?? 0);
}

/** 工具结果说工作台连不上（扩展的 `UnreachableError`、`DeadlineError`）时返回那句话；否则 undefined。 */
function workbenchUnreachable(record: Record<string, unknown>): string | undefined {
	if (record.type !== "tool_execution_end" || record.isError !== true) return undefined;
	const content = (record.result as { content?: unknown } | undefined)?.content;
	const text = Array.isArray(content)
		? content
				.map((c) =>
					c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "",
				)
				.join("")
		: "";
	const at = text.indexOf(WORKBENCH_UNREACHABLE);
	return at === -1 ? undefined : text.slice(at).split("\n")[0];
}

/** 一轮开头出错：消息能给人看，`cause` 是原来的错误（原文只进日志）。 */
class StartError extends Error {
	constructor(
		message: string,
		readonly cause: unknown,
	) {
		super(message);
	}
}

/** 清空一个目录（目录本身留着）。 */
function emptyDir(dir: string): void {
	try {
		for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
	} catch {
		// 目录已经没了（进程退出时删掉了）。
	}
}

/**
 * 事件里的字符串换成控制面存得进去的：NUL（U+0000）换成「␀」，不成对的代理字符换成 U+FFFD。
 * PostgreSQL 的 jsonb 不收 `\u0000`，也不收不成对的代理字符。
 */
export function storable<T>(value: T): T {
	if (typeof value === "string") {
		return value
			.replaceAll(String.fromCharCode(0), "␀")
			.replace(
				/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
				"\ufffd",
			) as T;
	}
	if (Array.isArray(value)) return value.map((item) => storable(item)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, storable(v)])) as T;
	}
	return value;
}
