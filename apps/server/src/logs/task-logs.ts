import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentMessage, type LogBatch, LogLevel, LogSource, type Progress } from "@sfly/proto";
import { eq } from "drizzle-orm";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	orchestrationVersions,
	runs,
	type TaskProgress,
	tasks,
} from "../db/schema.js";
import { Topics } from "../sse/topics.js";
import { maskSecrets, secretValues } from "./secrets.js";

/**
 * 任务日志与进度（docs/ARCHITECTURE.md §6.3）。
 *
 * ## 日志文件
 * - 每个任务（一次尝试）一个文件：`<数据目录>/logs/<run_id>/<task_id>.jsonl`，相对路径记在 `tasks.log_path`。
 *   按运行分目录，保留期清理可以按运行结束时间整目录删除。
 * - JSONL，每行一条日志，与 HTTP / SSE 返回的 {@link LogLineView} 完全相同：
 *   `{"seq":1,"time":"2026-01-01T00:00:00.000Z","source":"stdout","level":"info","text":"..."}`。
 *   文本里的换行被 JSON 转义，所以一行就是一条日志：任意行首的字节偏移都是合法的分页位置。
 * - 只追加。`tasks.log_bytes` 是已写入的字节数（= 文件大小），`tasks.log_seq` 是已写入的最大序号；
 *   序号不大于它的行视为重复而丢弃。secret 参数的值在写入前就替换成掩码，文件里没有明文。
 *
 * ## 进度
 * 只在 `tasks.progress` 保留最新值，不写文件。
 *
 * 日志和进度都不经过引擎的互斥锁（不改变运行状态）；同一个任务的追加按到达顺序串行执行。
 */

/** 一行日志（日志文件里的一行、SSE 推送的一项）。 */
export interface LogLineView {
	seq: number;
	time: string;
	source: "stdout" | "stderr" | "sdk";
	level: "debug" | "info" | "warn" | "error";
	text: string;
}

/** 连续的若干行日志，`offset` 是第一行在日志文件中的字节偏移（没有行时为文件大小）。 */
export interface LogChunk {
	task_id: string;
	lines: LogLineView[];
	offset: number;
}

/** 进度推送（运行的 SSE 上的 `progress` 事件）。 */
export interface ProgressEvent {
	run_id: string;
	chain_instance_id: string;
	node_id: string;
	task_id: string;
	progress: TaskProgress;
}

const SOURCES: Record<LogSource, LogLineView["source"]> = {
	[LogSource.UNSPECIFIED]: "stdout",
	[LogSource.STDOUT]: "stdout",
	[LogSource.STDERR]: "stderr",
	[LogSource.SDK]: "sdk",
};

const LEVELS: Record<LogLevel, LogLineView["level"]> = {
	[LogLevel.UNSPECIFIED]: "info",
	[LogLevel.DEBUG]: "debug",
	[LogLevel.INFO]: "info",
	[LogLevel.WARN]: "warn",
	[LogLevel.ERROR]: "error",
};

/** 订阅时最多从文件尾部读多少字节、多少行。 */
const TAIL_BYTES = 256 * 1024;
const TAIL_LINES = 500;
/** 缓存的任务状态数上限。 */
const CACHE_LIMIT = 1000;

interface TaskState {
	runId: string;
	chainInstanceId: string;
	nodeId: string;
	agentName: string | null;
	/** 相对数据目录。 */
	path: string;
	bytes: number;
	seq: number;
	secrets: string[];
}

export class TaskLogs {
	/** 新写入的日志（主题 = 任务 ID），写入文件之后发布。 */
	readonly lines = new Topics<LogChunk>();
	/** 进度更新（主题 = 运行 ID），写入数据库之后发布。 */
	readonly progress = new Topics<ProgressEvent>();

	#states = new Map<string, Promise<TaskState | undefined>>();
	#queues = new Map<string, Promise<void>>();

	constructor(private readonly deps: { db: Db; clock: Clock; dataDir: string }) {}

	/** 这条 Agent 消息是否由这里处理（日志、进度）。 */
	handles(message: AgentMessage): boolean {
		return message.body.case === "logs" || message.body.case === "progress";
	}

	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		if (message.body.case === "logs") await this.append(conn.name, message.body.value);
		else if (message.body.case === "progress")
			await this.recordProgress(conn.name, message.body.value);
	}

	/** 任务是否存在。 */
	async exists(taskId: string): Promise<boolean> {
		return (await this.#state(taskId)) !== undefined;
	}

	/** 追加一批日志（只接受任务所在 Agent 上报的）；同一任务的追加串行执行。 */
	append(agentName: string, batch: LogBatch): Promise<void> {
		return this.#serial(batch.taskId, async () => {
			const state = await this.#stateFor(batch.taskId, agentName);
			if (!state) return;
			const lines: LogLineView[] = [];
			let seq = state.seq;
			for (const line of batch.lines) {
				const n = Number(line.seq);
				if (n <= seq) continue;
				seq = n;
				lines.push({
					seq: n,
					time: this.#time(line.timeUnixMs),
					source: SOURCES[line.source] ?? "stdout",
					level: LEVELS[line.level] ?? "info",
					text: maskSecrets(line.text, state.secrets),
				});
			}
			if (lines.length === 0) return;
			const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
			const file = join(this.deps.dataDir, state.path);
			await mkdir(dirname(file), { recursive: true });
			await appendFile(file, text);
			const offset = state.bytes;
			state.bytes += Buffer.byteLength(text);
			state.seq = seq;
			await this.deps.db
				.update(tasks)
				.set({ logPath: state.path, logBytes: state.bytes, logSeq: state.seq })
				.where(eq(tasks.id, batch.taskId));
			this.lines.publish(batch.taskId, { task_id: batch.taskId, lines, offset });
		});
	}

	/** 记录最新进度（只接受任务所在 Agent 上报的）；与同一任务的日志追加串行执行。 */
	recordProgress(agentName: string, progress: Progress): Promise<void> {
		return this.#serial(progress.taskId, async () => {
			const state = await this.#stateFor(progress.taskId, agentName);
			if (!state) return;
			const value: TaskProgress = {
				current: progress.current,
				total: progress.total ?? null,
				message: maskSecrets(progress.message, state.secrets),
				time: this.#time(progress.timeUnixMs),
			};
			await this.deps.db
				.update(tasks)
				.set({ progress: value })
				.where(eq(tasks.id, progress.taskId));
			this.progress.publish(state.runId, {
				run_id: state.runId,
				chain_instance_id: state.chainInstanceId,
				node_id: state.nodeId,
				task_id: progress.taskId,
				progress: value,
			});
		});
	}

	/** 日志文件尾部最多 500 行中序号大于 `afterSeq` 的行。 */
	async tail(taskId: string, afterSeq = 0): Promise<LogChunk> {
		const state = await this.#state(taskId);
		const empty = { task_id: taskId, lines: [], offset: state?.bytes ?? 0 };
		if (!state) return empty;
		const file = join(this.deps.dataDir, state.path);
		const size = await stat(file).then(
			(s) => s.size,
			() => undefined,
		);
		if (size === undefined) return empty;
		const start = Math.max(0, size - TAIL_BYTES);
		const handle = await open(file, "r");
		let bytes: Buffer;
		try {
			bytes = Buffer.alloc(size - start);
			await handle.read(bytes, 0, bytes.length, start);
		} finally {
			await handle.close();
		}
		const found: Array<{ offset: number; line: LogLineView }> = [];
		// 从读到的第一个完整行开始（start > 0 时跳过被截断的半行），最后不完整的一行不算。
		let pos = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
		while (start === 0 || pos > 0) {
			const end = bytes.indexOf(0x0a, pos);
			if (end < 0) break;
			const line = JSON.parse(bytes.subarray(pos, end).toString("utf8")) as LogLineView;
			if (line.seq > afterSeq) found.push({ offset: start + pos, line });
			pos = end + 1;
		}
		const kept = found.slice(-TAIL_LINES);
		return {
			task_id: taskId,
			lines: kept.map((f) => f.line),
			offset: kept[0]?.offset ?? size,
		};
	}

	#time(unixMs: bigint): string {
		return unixMs > 0n
			? new Date(Number(unixMs)).toISOString()
			: this.deps.clock.now().toISOString();
	}

	#serial(taskId: string, work: () => Promise<void>): Promise<void> {
		const previous = this.#queues.get(taskId) ?? Promise.resolve();
		const next = previous.then(work, work);
		const settled = next.catch(() => {});
		this.#queues.set(taskId, settled);
		void settled.then(() => {
			if (this.#queues.get(taskId) === settled) this.#queues.delete(taskId);
		});
		return next;
	}

	/** 任务所在 Agent 是 agentName 时的状态；缓存里的可能是派发之前读到的，不一致时重新读取一次。 */
	async #stateFor(taskId: string, agentName: string): Promise<TaskState | undefined> {
		let state = await this.#state(taskId);
		if (state && state.agentName !== agentName) {
			this.#states.delete(taskId);
			state = await this.#state(taskId);
		}
		return state?.agentName === agentName ? state : undefined;
	}

	#state(taskId: string): Promise<TaskState | undefined> {
		let state = this.#states.get(taskId);
		if (!state) {
			state = this.#load(taskId);
			this.#states.set(taskId, state);
			// 没找到的任务不缓存（可能稍后才创建）；缓存超过上限时丢掉最早的。
			void state.then(
				(s) => {
					if (!s) this.#states.delete(taskId);
				},
				() => this.#states.delete(taskId),
			);
			if (this.#states.size > CACHE_LIMIT) {
				const oldest = this.#states.keys().next().value;
				if (oldest !== undefined) this.#states.delete(oldest);
			}
		}
		return state;
	}

	async #load(taskId: string): Promise<TaskState | undefined> {
		const [row] = await this.deps.db
			.select({ task: tasks, document: orchestrationVersions.document })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(tasks.id, taskId));
		if (!row) return undefined;
		const { task, document } = row;
		const chains = await this.deps.db
			.select({ chainId: chainInstances.chainId, params: chainInstances.params })
			.from(chainInstances)
			.where(eq(chainInstances.runId, task.runId));
		const path = task.logPath ?? join("logs", task.runId, `${task.id}.jsonl`);
		// 文件大小是已写入字节数的准绳（数据库更新之前控制面可能退出过）。
		const bytes = await stat(join(this.deps.dataDir, path)).then(
			(s) => s.size,
			() => 0,
		);
		return {
			runId: task.runId,
			chainInstanceId: task.chainInstanceId,
			nodeId: task.nodeId,
			agentName: task.agentName,
			path,
			bytes,
			seq: task.logSeq,
			secrets: secretValues(document, chains),
		};
	}
}
