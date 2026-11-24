import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { ASSISTANT_PROCESS_KILL_GRACE_MS } from "@sfly/schema";
import { type Clock, realClock } from "./clock.js";
import { LineSplitter } from "./jsonl.js";

/**
 * 一个 RPC 模式的 pi 进程（pi `docs/rpc.md`）：写命令（照顾 stdin 的背压），按 LF 切读 stdout 的记录，
 * 标准错误另存成文件（不当协议解析）。不用 pi 自带的 `RpcClient`：它把宿主进程的环境整个带给子进程。
 *
 * 结束的两种做法（#539 第 8 题）：
 * - {@link PiProcess.close}：关 stdin，pi 有序退出，宽限之后还没退出就 SIGKILL（协议「结束会话」）。**只在空闲时用**：
 *   一轮进行中关 stdin，pi 不等这一轮做完，正在跑的命令被中止；
 * - {@link PiProcess.terminate}：先关 stdin，再 SIGTERM，{@link KILL_GRACE_MS} 之后还没退出就 SIGKILL（pi
 *   「Shutdown」：第二个信号立即退出）。停止一轮等不到 `agent_settled`、助手服务退出时用它。#539 第 8 题实测：一轮进行中关 stdin、
 *   关 stdin 同时 SIGTERM、stdin 开着只发 SIGTERM，pi 都中止正在跑的命令、很快退出，会话文件的最后一行完整；
 *   两样都发，不靠其中哪一样单独起作用。
 */

/** 协议里的停止宽限（控制面等停止的时间引用同一个数）。 */
export const KILL_GRACE_MS = ASSISTANT_PROCESS_KILL_GRACE_MS;

export interface PiProcessOptions {
	/** 要执行的命令（`[node, <pi 的命令行入口>, ...参数]`；测试里换成假的 pi）。 */
	argv: string[];
	cwd: string;
	/** 子进程的全部环境：不继承助手服务自己的环境。 */
	env: Record<string, string>;
	/** 标准错误另存到这个文件。 */
	stderrPath: string;
	/** 每一条记录（解析过的 JSON；不是 JSON 的行给 `undefined`）和原样的那一行。 */
	onRecord: (record: Record<string, unknown> | undefined, line: string) => void;
	/** 进程退出：退出码和信号。 */
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	/** 结束时等 SIGTERM 生效的时间，默认 {@link KILL_GRACE_MS}（测试里改短）。 */
	killGraceMs?: number;
	/** 宽限的计时（测试里换成手动推进的时钟）。 */
	clock?: Clock;
	/** 标准错误写下之前过一遍（打码）；`flush` 在进程退出时调用。 */
	filterStderr?: { push: (text: string) => string; flush: () => string };
	/** 写标准错误的文件出错（磁盘满）：不让它变成未处理的异常。 */
	onStderrError?: (error: Error) => void;
}

/** 进程没了（已经退出，或者写不进去）时 {@link PiProcess.request} 的回应。 */
export const GONE: Record<string, unknown> = Object.freeze({
	type: "response",
	success: false,
	error: "pi 进程已退出",
	gone: true,
});

export class PiProcess {
	readonly #child: ChildProcess;
	readonly #stderr: WriteStream;
	readonly #grace: number;
	readonly #clock: Clock;
	readonly #exited: Promise<void>;
	readonly #waiting = new Map<string, (response: Record<string, unknown>) => void>();
	#nextId = 0;
	#exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

	constructor(options: PiProcessOptions) {
		this.#grace = options.killGraceMs ?? KILL_GRACE_MS;
		this.#clock = options.clock ?? realClock;
		this.#stderr = createWriteStream(options.stderrPath, { flags: "a", mode: 0o600 });
		this.#stderr.on("error", (error) => options.onStderrError?.(error));
		const [command, ...args] = options.argv;
		if (!command) throw new Error("没有要执行的命令");
		this.#child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const splitter = new LineSplitter();
		const handle = (line: string) => {
			let record: Record<string, unknown> | undefined;
			try {
				const parsed: unknown = JSON.parse(line);
				record =
					parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
			} catch {
				record = undefined;
			}
			if (record?.type === "response" && typeof record.id === "string") {
				this.#waiting.get(record.id)?.(record);
				this.#waiting.delete(record.id);
			}
			options.onRecord(record, line);
		};
		this.#child.stdout?.on("data", (chunk: Buffer) => {
			for (const line of splitter.push(chunk)) handle(line);
		});
		const filter = options.filterStderr;
		// 按 UTF-8 解码时不把一个字符切成两半（打码按字符比较）。
		const decoder = new StringDecoder("utf8");
		this.#child.stderr?.on("data", (chunk: Buffer) => {
			this.#stderr.write(filter ? filter.push(decoder.write(chunk)) : chunk);
		});
		// stdin 在 pi 退出后写不进去：错误由等待的调用方处理，这里不让它变成未处理的异常。
		this.#child.stdin?.on("error", () => {});
		this.#exited = new Promise((resolve) => {
			this.#child.on("error", (error) => {
				this.#stderr.write(`\n启动 pi 失败：${error.message}\n`);
			});
			this.#child.on("close", (code, signal) => {
				const tail = splitter.end();
				if (tail !== undefined) handle(tail);
				this.#exit = { code, signal };
				for (const resolveWaiting of this.#waiting.values()) resolveWaiting(GONE);
				this.#waiting.clear();
				this.#stderr.end(filter ? filter.push(decoder.end()) + filter.flush() : "");
				options.onExit(code, signal);
				resolve();
			});
		});
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	get exited(): boolean {
		return this.#exit !== undefined;
	}

	/** 等进程退出。 */
	wait(): Promise<void> {
		return this.#exited;
	}

	/** 写一条命令（不等回应）。stdin 的缓冲满了时等它排空再返回。 */
	async send(command: Record<string, unknown>): Promise<void> {
		const stdin = this.#child.stdin;
		if (!stdin || this.exited || stdin.destroyed) throw new Error("pi 进程已退出");
		const line = `${JSON.stringify(command)}\n`;
		if (!stdin.write(line)) {
			await Promise.race([once(stdin, "drain"), this.#exited]);
		}
	}

	/**
	 * 写一条命令并等它的回应（`response`，按 ID 对应）。**不会拒绝**：进程先退出、或者写不进去（pi 刚退出、助手服务还没收到
	 * 它退出的那一小段，写会同步抛错或者碰上管道已断）时，回应是失败、带 `gone: true`（#677 审查：没人接的拒绝会带走整个
	 * 助手服务）。这一轮怎么收尾由进程退出的那条路定（{@link PiProcessOptions.onExit}）。
	 */
	async request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `sfly-${++this.#nextId}`;
		const response = new Promise<Record<string, unknown>>((resolve) =>
			this.#waiting.set(id, resolve),
		);
		try {
			await this.send({ ...command, id });
		} catch {
			this.#waiting.delete(id);
			return GONE;
		}
		return response;
	}

	/**
	 * 关 stdin，等 pi 有序退出。**只在空闲时调用**（见类的说明）。`graceMs` 之后还没退出就 SIGKILL。
	 */
	async close(graceMs = this.#grace): Promise<void> {
		if (this.exited) return;
		this.#child.stdin?.end();
		const timer = this.#clock.setTimeout(() => {
			if (!this.exited) this.#child.kill("SIGKILL");
		}, graceMs);
		try {
			await this.#exited;
		} finally {
			this.#clock.clearTimeout(timer);
		}
	}

	/** 先关 stdin，再 SIGTERM，宽限期之后还没退出就 SIGKILL；等它退出。 */
	async terminate(): Promise<void> {
		if (this.exited) return;
		this.#child.stdin?.end();
		this.#child.kill("SIGTERM");
		const timer = this.#clock.setTimeout(() => {
			if (!this.exited) this.#child.kill("SIGKILL");
		}, this.#grace);
		try {
			await this.#exited;
		} finally {
			this.#clock.clearTimeout(timer);
		}
	}
}
