import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AssistantErrorCode,
	AssistantEvent,
	ErrorClass,
	PromptCommandBody,
	TurnLimit,
	TurnOutcome,
} from "@sfly/schema";
import type { AgentClient } from "./agent.js";
import type { EventBus } from "./bus.js";
import { type LaunchPaths, prepareLaunch, writeContextFile } from "./launch.js";
import { KILL_GRACE_MS, PiProcess } from "./pi-process.js";
import { Redactor } from "./redact.js";
import { mirrorSkillsLocally, workbenchSkillsDir, writeSkillsToWorkbench } from "./skills.js";
import { TurnTranslator } from "./translate.js";
import type { TurnConfig } from "./turn-config.js";

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
 * 中止到得比这一轮早（控制面等 `prompt` 的回应超时，补发一次中止；那句 `prompt` 还在路上）：中止记下来，这么久之内
 * 到的下一轮直接以 `stopped` 结束，不拉起 pi。控制面等回应只等 10 秒，补发的中止紧跟着发出，留足余量。
 */
export const EARLY_ABORT_WINDOW_MS = 30_000;

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
	connect: (address: string) => AgentClient;
	log: (message: string) => void;
	limits?: { modelCalls: number; durationMs: number };
	maxProcesses?: number;
	earlyAbortWindowMs?: number;
	killGraceMs?: number;
}

interface Turn {
	number: number;
	startedAt: number;
	translator: TurnTranslator;
	timer: NodeJS.Timeout | undefined;
	/** 由助手服务结束这一轮时的结局（停止、上限）：pi 进程退出后据此写 `turn_end`。 */
	ending: { outcome: TurnOutcome; reason: string; limit?: TurnLimit } | undefined;
	ended: boolean;
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
	turn: Turn | undefined;
	lastActive: number;
	/** 这个助手服务进程里，这个会话最近一轮的轮次（重启之后不知道）。 */
	lastTurn: number | undefined;
	/** 没有在做的一轮时收到的中止：{@link EARLY_ABORT_WINDOW_MS} 之内到的下一轮直接结束。 */
	earlyAbort: { at: number; afterTurn: number | undefined } | undefined;
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

	constructor(private readonly options: SessionManagerOptions) {
		this.#limits = options.limits ?? TURN_LIMITS;
		this.#maxProcesses = options.maxProcesses ?? MAX_PROCESSES;
		mkdirSync(join(options.dataDir, "sessions"), { recursive: true });
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
		if (session.turn) {
			return { ok: false, status: 409, code: "turn_running", message: "这个会话已有一轮在做" };
		}
		session.redactor.add(Object.values(body.secret_env));
		if (this.#abortedEarly(session, body.turn)) {
			// 控制面在这一轮登记下来之前就要求停止了：不拉起 pi，直接结束。
			const turn = this.#register(session, body.turn);
			this.options.log(`会话 ${session.id} 第 ${body.turn} 轮：到之前已经收到中止，直接结束`);
			this.#end(session, turn, {
				outcome: "stopped",
				reason: "这一轮到之前已经要求停止了",
			});
			return { ok: true };
		}
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
		const turn: Turn = {
			number,
			startedAt: Date.now(),
			translator: new TurnTranslator(session.redactor),
			timer: undefined,
			ending: undefined,
			ended: false,
		};
		session.turn = turn;
		session.lastTurn = number;
		session.lastActive = Date.now();
		return turn;
	}

	/**
	 * 这一轮到之前是不是已经收到过中止：中止在 {@link EARLY_ABORT_WINDOW_MS} 之内，并且这一轮紧接着中止时最近的那一轮
	 * （控制面没接住的那一轮，下一次是新的轮次；不知道最近一轮时只看时间）。看过就清掉：只作用于一轮。
	 */
	#abortedEarly(session: Session, number: number): boolean {
		const early = session.earlyAbort;
		session.earlyAbort = undefined;
		if (!early) return false;
		const window = this.options.earlyAbortWindowMs ?? EARLY_ABORT_WINDOW_MS;
		if (Date.now() - early.at > window) return false;
		return early.afterTurn === undefined || number === early.afterTurn + 1;
	}

	/** 这个会话现在的 pi 进程号（诊断和测试用）；没有活着的进程时 undefined。 */
	pid(sessionId: string): number | undefined {
		const process = this.#sessions.get(sessionId)?.process;
		return process && !process.exited ? process.pid : undefined;
	}

	/**
	 * `POST /sessions/:id/abort`：竖切版，直接结束 pi 进程，这一轮以 `stopped` 结束（#544 改成先中止）。
	 * 没有在做的一轮时不当成没这回事：控制面等 `prompt` 的回应超时之后会补发中止，那句 `prompt` 可能还没到。
	 * 记下来，紧接着到的那一轮直接结束（{@link EARLY_ABORT_WINDOW_MS}）。
	 */
	abort(sessionId: string): void {
		const session = this.#session(sessionId);
		const turn = session.turn;
		if (!turn) {
			session.earlyAbort = { at: Date.now(), afterTurn: session.lastTurn };
			return;
		}
		this.#stop(session, turn, { outcome: "stopped", reason: "用户停止了这一轮" });
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
				turn: undefined,
				lastActive: Date.now(),
				lastTurn: undefined,
				earlyAbort: undefined,
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
				await writeSkillsToWorkbench(
					this.options.connect(body.workbench.address),
					this.options.skillsDir,
					body.workbench.workdir,
				);
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
			const message = error instanceof Error ? error.message : String(error);
			this.options.log(
				`会话 ${session.id} 第 ${turn.number} 轮开始失败：${session.redactor.redact(message)}`,
			);
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
		});
		session.startedFor = startedFor;
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
				raw.write(`${session.redactor.redact(line)}\n`);
				this.#onRecord(session, process, record);
			},
			onExit: (code, signal) => {
				raw.end();
				// 这次启动新建的设置目录用完就删（不和别的进程、别的会话共用）。
				rmSync(launch.agentDir, { recursive: true, force: true });
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
		const { events, unknown } = turn.translator.translate(record);
		if (unknown) this.options.log(`会话 ${session.id}：认不出的 pi 事件 ${unknown}`);
		for (const event of events) this.#emit(session, turn, event);
		if (record.type === "turn_start" && turn.translator.modelCalls > this.#limits.modelCalls) {
			this.#stop(session, turn, {
				outcome: "limit",
				reason: `这一轮调用模型到了 ${this.#limits.modelCalls} 次的上限`,
				limit: "model_calls",
			});
			return;
		}
		if (record.type === "agent_settled") {
			const t = turn.translator;
			if (record.aborted === true) {
				this.#end(session, turn, { outcome: "stopped", reason: "这一轮被中止了" });
			} else if (t.retriesExhausted !== undefined || t.lastModelError !== undefined) {
				const detail = t.retriesExhausted ?? t.lastModelError ?? "";
				this.#end(session, turn, {
					outcome: "model_unavailable",
					reason: `模型不可用：${session.redactor.redact(detail)}`,
					errorClass: "other",
				});
			} else {
				this.#end(session, turn, { outcome: "completed", reason: "这一轮做完了" });
			}
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
		rmSync(this.#paths(session).turnConfig, { force: true });
		if (session.turn === turn) session.turn = undefined;
		session.lastActive = Date.now();
	}

	#emit(session: Session, turn: Turn, event: AssistantEvent): void {
		this.options.bus.emit(session.id, turn.number, session.redactor.redactValue(event));
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
