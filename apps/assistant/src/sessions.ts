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
import type {
	AssistantErrorCode,
	AssistantEvent,
	ErrorClass,
	PromptCommandBody,
	TurnLimit,
	TurnOutcome,
} from "@sfly/schema";
import { type AgentClient, WORKBENCH_UNREACHABLE, WorkbenchError } from "./agent.js";
import type { EventBus } from "./bus.js";
import { type LaunchPaths, prepareLaunch, writeContextFile } from "./launch.js";
import { modelEnvRefs } from "./models.js";
import { KILL_GRACE_MS, PiProcess } from "./pi-process.js";
import { forLog, Redactor } from "./redact.js";
import { mirrorSkillsLocally, workbenchSkillsDir, writeSkillsToWorkbench } from "./skills.js";
import { TurnTranslator } from "./translate.js";
import type { TurnConfig } from "./turn-config.js";
import type { UpstreamError } from "./upstream-error.js";

/**
 * 看管 pi 进程和一轮（#540）：一个会话一个 pi 进程（RPC 模式），一轮从 `prompt` 开始，到 pi 报告 `agent_settled`、
 * 到了上限、被停止或 pi 进程退出为止，以一条 `turn_end` 结束。
 *
 * - 先回应 `prompt`（已接受），再去拉起 pi：控制面等回应只等 10 秒，冷启动（#539 第 9 题最慢 2.6 秒）加第一次调模型
 *   不能算在里面。拉起失败、写不了工作台上的 skill，这一轮以 `failed` 结束。
 * - 每一轮的上限在这里执行，模型够不着：{@link TURN_LIMITS}。到了就结束 pi 进程（先关 stdin，再 SIGTERM，10 秒后 SIGKILL），
 *   这一轮以 `limit` 结束；会话还能接着说（下一轮用同一条启动命令起 pi，从会话文件恢复）。
 * - 同时活着的 pi 进程数有上限（{@link MAX_PROCESSES}）。到了上限时，先关掉最久没用的**空闲**进程（关 stdin：
 *   它没有在做的一轮，#539 第 8 题）；没有空闲的就拒绝（503 `process_limit`，控制面把这一轮记成 `failed`）。
 *   为了回收而关 stdin 只对空闲的进程做（一轮进行中关了，pi 不等这一轮做完）；停止、上限走结束进程。
 * - 保密环境变量的值在发出事件、写下 pi 的原始事件、写日志之前按值打码（redact.ts）。
 */

export const TURN_LIMITS = {
	/** 一轮最多调用模型的次数（数 pi 的 `turn_start`，第 41 次之前结束）。 */
	modelCalls: 40,
	/** 一轮最长的时间。 */
	durationMs: 20 * 60 * 1000,
} as const;

/**
 * 同时活着的 pi 进程数的上限：一个空闲的 pi 进程常驻约 117 MiB，一轮里的峰值约 137 MiB（#539 第 9 题），
 * 8 个约 1.1 GiB；助手容器的内存上限定 2 GiB，给助手服务自己和打包、读写留出余量。
 */
export const MAX_PROCESSES = 8;

/**
 * 「这一轮已被中止」的记号（中止比这一轮的 `prompt` 先到）：留多久、最多留几个（每个会话只留轮次最大的那一个）。
 * 只认轮次，不看时间；过期和上限只为不让记号无限增长。
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
	killGraceMs?: number;
	/**
	 * pi 进程的临时目录建在这下面（每个进程一个，`TMPDIR`），默认容器自己的临时目录下的 `sfly-assistant-<数据目录的哈希>/`：
	 * 截断输出的全文按「两边路径相同」传到工作台上同一个路径，工作台上 `/tmp` 一定在、谁都能写；它也不该占数据卷。
	 * 按数据目录分开：本机起两个助手服务时，后起的启动清理不删先起的那个的；同一个数据目录重启后认得出上次留下的。
	 */
	tmpRoot?: string;
}

interface Turn {
	number: number;
	startedAt: number;
	translator: TurnTranslator;
	timer: NodeJS.Timeout | undefined;
	/** 由助手服务结束这一轮时的结局（停止、上限）：pi 进程退出后据此写 `turn_end`。 */
	ending: { outcome: TurnOutcome; reason: string; limit?: TurnLimit } | undefined;
	ended: boolean;
	/** 这一轮的工作台（能力端口的地址）：工具结果说工作台连不上时，助手服务自己探它。 */
	address: string | undefined;
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
	/** 现在这个 pi 进程的临时目录（`TMPDIR`）。 */
	tmpDir: string | undefined;
	turn: Turn | undefined;
	lastActive: number;
	/** 这个助手服务进程里，这个会话登记过的最大轮次（重启之后不知道）。 */
	lastTurn: number | undefined;
}

export type PromptResult =
	| { ok: true }
	| { ok: false; status: number; code: AssistantErrorCode; message: string };

export class SessionManager {
	readonly #sessions = new Map<string, Session>();
	readonly #limits: { modelCalls: number; durationMs: number };
	readonly #maxProcesses: number;
	/** 正在关的 pi 进程（关 stdin 之后、退出之前）。 */
	readonly #closing = new Set<PiProcess>();
	/** 「这一轮已被中止」的记号：会话 ID → 轮次（见 {@link abort}）。按记下的先后排，满了丢最早的。 */
	readonly #abortMarks = new Map<string, { turn: number; at: number }>();

	/** 模型文件引用的环境变量的值（模型的密钥）：写日志时也打码。第一次用到时读。 */
	#modelSecrets: Redactor | undefined;

	constructor(private readonly options: SessionManagerOptions) {
		this.#limits = options.limits ?? TURN_LIMITS;
		this.#maxProcesses = options.maxProcesses ?? MAX_PROCESSES;
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
			if (s.process ? !s.process.exited : s.turn && !s.turn.ended && !s.turn.ending) count += 1;
		}
		return count;
	}

	get maxProcesses(): number {
		return this.#maxProcesses;
	}

	/** `POST /sessions/:id/prompt`：先回应，再在后台拉起 pi、发 `prompt`。 */
	prompt(sessionId: string, body: PromptCommandBody): PromptResult {
		const session = this.#session(sessionId);
		if (this.#hitsAbortMark(sessionId, body.turn)) {
			// 这一轮登记之前就收到了针对它的中止：先回 202（回 409、503 控制面会记成失败），再发这一轮「已停止」的结局，
			// 不拉起 pi。更早的一轮还在退出（停止之后 pi 还没走）时也一样：先看记号、再看在做的那一轮，这一轮不登记成
			// 在做的，不影响更早的那一轮在进程退出时发它的结局。
			const turn = this.#newTurn(session, body.turn);
			session.lastTurn = Math.max(session.lastTurn ?? 0, body.turn);
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
		session.redactor.add(Object.values(body.secret_env));
		// 更大的轮次到了：比它小的记号对应的那一轮不会再来了，清掉。
		this.#dropStaleAbortMark(sessionId, body.turn);
		if (!session.process || session.process.exited) {
			if (this.activeProcesses >= this.#maxProcesses && !this.#evictIdle()) {
				return {
					ok: false,
					status: 503,
					code: "process_limit",
					message: `同时活着的 pi 进程已经有 ${this.#maxProcesses} 个，都在做`,
				};
			}
		}
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
		const turn = this.#register(session, body.turn);
		turn.address = body.workbench.address;
		turn.workbenchName = body.workbench.name;
		turn.timer = setTimeout(
			() =>
				this.#stop(session, turn, {
					outcome: "limit",
					reason: "这一轮用时到了上限",
					limit: "duration",
				}),
			this.#limits.durationMs,
		);
		void this.#start(session, turn, body);
		return { ok: true };
	}

	/** 登记这一轮（还没有拉起 pi）。 */
	#register(session: Session, number: number): Turn {
		const turn = this.#newTurn(session, number);
		session.turn = turn;
		session.lastTurn = number;
		session.lastActive = Date.now();
		return turn;
	}

	#newTurn(session: Session, number: number): Turn {
		return {
			number,
			startedAt: Date.now(),
			translator: new TurnTranslator(session.redactor),
			timer: undefined,
			ending: undefined,
			ended: false,
			address: undefined,
			workbenchName: "工作台",
			probing: false,
			settled: undefined,
		};
	}

	/** 这一轮的 `prompt` 撞上了针对它的记号（同一轮、没过期）：取走记号。过期的记号清掉。 */
	#hitsAbortMark(sessionId: string, number: number): boolean {
		const mark = this.#abortMarks.get(sessionId);
		if (!mark) return false;
		if (Date.now() - mark.at > ABORT_MARK_TTL_MS) {
			this.#abortMarks.delete(sessionId);
			return false;
		}
		if (number !== mark.turn) return false;
		this.#abortMarks.delete(sessionId);
		return true;
	}

	/** 轮次更大的 `prompt` 到了：记号对应的那一轮不会再来了，清掉；更小的不动。 */
	#dropStaleAbortMark(sessionId: string, number: number): void {
		const mark = this.#abortMarks.get(sessionId);
		if (mark && number > mark.turn) this.#abortMarks.delete(sessionId);
	}

	/** 记下「第 `turn` 轮已被中止」：每个会话只留轮次最大的那一个，总数有上限（满了丢最早的）。 */
	#markAborted(sessionId: string, turn: number): void {
		const known = this.#abortMarks.get(sessionId);
		if (known && known.turn >= turn && Date.now() - known.at <= ABORT_MARK_TTL_MS) return;
		this.#abortMarks.delete(sessionId);
		this.#abortMarks.set(sessionId, { turn, at: Date.now() });
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
	 * `POST /sessions/:id/abort`：结束第 `turn` 轮（竖切版直接结束 pi 进程，#544 改成先中止）。按这一轮的状态，不按时间猜：
	 * - 在做的那一轮的轮次不大于 `turn`：结束它，以 `stopped` 结束。不只是同一轮：回过一次 409 之后控制面那次发话已经把
	 *   轮次加了一，用户之后在空闲的会话上点停止带的是新轮次，真正还在跑的是上一轮；
	 * - 第 `turn` 轮还没登记（控制面等 `prompt` 的回应超时后补发的中止，那句 `prompt` 还在路上；或者上面那种情况）：记下
	 *   记号，它的 `prompt` 到了直接以 `stopped` 结束。可以和上一条同时发生。助手服务重启之后分不清「已经结束」和「还没
	 *   登记」时也记下：记号只和同一轮的 `prompt` 对得上；
	 * - 都不是（这一轮已经结束、或者是更早的轮次）：什么也不做。
	 * 在做的轮次比 `turn` 大时不动它；重复调用无害。
	 */
	abort(sessionId: string, turn: number): void {
		const session = this.#sessions.get(sessionId);
		const current = session?.turn;
		if (session && current && current.number <= turn) {
			this.#stop(session, current, { outcome: "stopped", reason: "用户停止了这一轮" });
		}
		const known = Math.max(session?.lastTurn ?? 0, current?.number ?? 0);
		if (session?.lastTurn !== undefined && turn <= known) return;
		this.#markAborted(sessionId, turn);
	}

	/** 助手服务退出：结束全部一轮和 pi 进程。 */
	async shutdown(): Promise<void> {
		for (const session of this.#sessions.values()) {
			if (session.turn) {
				this.#stop(session, session.turn, { outcome: "interrupted", reason: "助手服务停止了" });
			}
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
				lastActive: Date.now(),
				lastTurn: undefined,
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

	async #start(session: Session, turn: Turn, body: PromptCommandBody): Promise<void> {
		const wanted = { workbench: body.workbench.name, workdir: body.workbench.workdir };
		let spawned = false;
		try {
			if (
				session.process &&
				!session.process.exited &&
				(session.startedFor?.workbench !== wanted.workbench ||
					session.startedFor?.workdir !== wanted.workdir)
			) {
				// 换了工作台或工作区：工具和系统提示里的路径是启动时定的，空闲的进程关掉重起。
				this.#close(session);
			}
			// 被关掉的进程退出之前不起新的：两个 pi 不同时写同一个会话文件。
			await session.closing;
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
				if (turn.ended || turn.ending) return;
				this.#spawn(session, wanted);
				spawned = true;
			}
			const process = session.process;
			if (!process || turn.ended || turn.ending) return;
			const response = await process.request({ type: "prompt", message: body.text });
			if (spawned) {
				// 冷启动：从收到这句话到新起的 pi 接受它（写 skill、起进程、加载扩展、恢复会话）。
				this.options.log(
					`会话 ${session.id} 第 ${turn.number} 轮：新起的 pi 接受了这句话，冷启动 ${Date.now() - turn.startedAt} 毫秒`,
				);
			}
			if (response.success !== true && !turn.ended) {
				this.#end(session, turn, {
					outcome: "failed",
					reason: `pi 没有接受这句话：${session.redactor.redact(String(response.error ?? ""))}`,
				});
			}
		} catch (error) {
			if (turn.ended) return;
			const raw = error instanceof StartError ? error.cause : error;
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮开始失败（工作台 ${body.workbench.name}，${body.workbench.address}）：${this.#forLog(session, raw instanceof Error ? raw.message : String(raw))}`,
			);
			const message = error instanceof Error ? error.message : String(error);
			this.#end(session, turn, {
				outcome: "failed",
				reason: `开始这一轮失败：${session.redactor.redact(message)}`,
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
		const raw = createWriteStream(join(session.dir, "events.jsonl"), { flags: "a", mode: 0o600 });
		raw.on("error", (error) =>
			this.options.log(`会话 ${session.id}：写 events.jsonl 失败：${error.message}`),
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
				this.options.log(`会话 ${session.id}：写 pi-stderr.log 失败：${error.message}`),
			killGraceMs: this.options.killGraceMs,
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

	#onRecord(
		session: Session,
		process: PiProcess,
		record: Record<string, unknown> | undefined,
	): void {
		const turn = session.turn;
		// 决定结束这一轮之后（停止、上限）pi 还在吐的事件不再外传：一轮的事件到此为止。
		if (!record || !turn || turn.ended || turn.ending || session.process !== process) return;
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
		const unreachable = workbenchUnreachable(record);
		if (unreachable !== undefined && turn.address !== undefined && !turn.probing) {
			// 工具结果里有「工作台连不上」：可能是扩展写的，也可能是命令自己打出来的、读到的文件路径里带的。只看文字定不下来，
			// 助手服务自己探一次这一轮的工作台：探不通才不等到上限、以失败结束这一轮；探得通就是普通的工具错误，照常往下走。
			turn.probing = true;
			const address = turn.address;
			const name = turn.workbenchName;
			const probe = this.options.connect(address);
			void probe.reachable().then((ok) => {
				// 探完就关：每探一次是一条新连接，留着它会空闲 15 分钟、其间一直 ping。
				probe.close();
				turn.probing = false;
				const settled = turn.settled;
				turn.settled = undefined;
				if (turn.ended || turn.ending) return;
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
		const turn = session.turn;
		if (!turn || turn.ended) return;
		if (turn.ending) {
			this.#end(session, turn, turn.ending);
			return;
		}
		const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
		this.options.log(`会话 ${session.id} 第 ${turn.number} 轮里 pi 进程退出了（${how}）`);
		this.#end(session, turn, {
			outcome: "interrupted",
			reason: `pi 进程在这一轮里退出了（${how}）`,
		});
	}

	/** 由助手服务结束这一轮（停止、上限）：结束 pi 进程，进程退出后写 `turn_end`。 */
	#stop(session: Session, turn: Turn, ending: NonNullable<Turn["ending"]>): void {
		if (turn.ended || turn.ending) return;
		turn.ending = ending;
		const process = session.process;
		if (process && !process.exited) {
			void process.terminate();
		} else {
			this.#end(session, turn, ending);
		}
	}

	#end(
		session: Session,
		turn: Turn,
		end: { outcome: TurnOutcome; reason: string; limit?: TurnLimit; errorClass?: ErrorClass },
	): void {
		if (turn.ended) return;
		turn.ended = true;
		clearTimeout(turn.timer);
		const t = turn.translator;
		this.#emit(session, turn, {
			type: "turn_end",
			turn: turn.number,
			outcome: end.outcome,
			reason: end.reason,
			steps: t.steps,
			// 到了模型调用的上限时，第 41 次 `turn_start` 之后就结束了，那一次没有调出去。
			model_calls: end.limit === "model_calls" ? t.modelCalls - 1 : t.modelCalls,
			duration_ms: Date.now() - turn.startedAt,
			usage: t.usage,
			...(end.limit && { limit_kind: end.limit }),
			...(end.errorClass && { error_class: end.errorClass }),
		});
		// 撞上记号直接结束的那一轮没有登记成在做的：更早的一轮可能还在退出，它的配置和临时文件留给它。
		if (session.turn === turn || session.turn === undefined) {
			rmSync(this.#paths(session).turnConfig, { force: true });
			// 这一轮命令的完整输出已经传到工作台上了：助手容器里的临时文件清掉（不占所有会话共用的磁盘）。
			if (session.tmpDir) emptyDir(session.tmpDir);
		}
		if (session.turn === turn) session.turn = undefined;
		session.lastActive = Date.now();
	}

	#emit(session: Session, turn: Turn, event: AssistantEvent): void {
		// 先打码，再把 NUL 和不成对的代理字符换掉（控制面的数据库存不进去，存不进去这条事件就丢了）。
		this.options.bus.emit(session.id, turn.number, storable(session.redactor.redactValue(event)));
	}

	/** 关掉最久没用的空闲 pi 进程（没有在做的一轮，关 stdin 安全）；关了一个返回 true。 */
	#evictIdle(): boolean {
		const idle = [...this.#sessions.values()]
			.filter((s) => s.process && !s.process.exited && !s.turn)
			.sort((a, b) => a.lastActive - b.lastActive)[0];
		if (!idle?.process) return false;
		this.#close(idle);
		return true;
	}

	/**
	 * 关掉这个会话的 pi 进程：**只用于空闲的进程**（关 stdin，#539 第 8 题）；它不再是这个会话的进程，
	 * 退出之前算进上限；不肯退出的在宽限期之后结束（SIGTERM，再 SIGKILL）。
	 */
	#close(session: Session): void {
		const process = session.process;
		if (!process) return;
		session.process = undefined;
		this.#closing.add(process);
		const closed = process.close(this.options.killGraceMs ?? KILL_GRACE_MS);
		session.closing = closed.finally(() => {
			if (session.closing === closed) session.closing = undefined;
		});
	}
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
