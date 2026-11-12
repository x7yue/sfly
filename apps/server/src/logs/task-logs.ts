import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentMessage, type LogBatch, LogLevel, LogSource, type Progress } from "@sfly/proto";
import type { TaskProgressView } from "@sfly/schema";
import { eq } from "drizzle-orm";
import { recordableAgentTimeMs } from "../agents/agent-clock.js";
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
import { readLogPage } from "./log-pages.js";
import { maskSecrets, secretValues } from "./secrets.js";

/**
 * 任务日志与进度（docs/ARCHITECTURE.md §6.3）。
 *
 * ## 日志文件
 * - 每个任务（一次尝试）一个文件：`<数据目录>/logs/<run_id>/<task_id>.jsonl`，相对路径记在 `tasks.log_path`。
 *   按运行分目录，保留期清理可以按运行结束时间整目录删除。
 * - JSONL，每行一条日志，与 HTTP / SSE 返回的 {@link LogLineView} 完全相同（字段顺序也相同）：
 *   `{"seq":1,"time":"2026-01-01T00:00:00.000Z","agent_time":"2027-09-06T00:00:00.000Z","source":"stdout","level":"info","text":"..."}`。
 *   文本里的换行被 JSON 转义，所以一行就是一条日志：任意行首的字节偏移都是合法的分页位置。
 * - 每行带两种时间（ADR 0018）：`time` 是控制面时间，由这一行的单调时钟读数按连接的对应关系折算
 *   （旧版本 Agent 没有读数时取收到这一批的时刻）；`agent_time` 是 Agent 时间，原样保存，不做范围检查。
 *   同一个任务内 `time` 随 seq 不减：折算出的时间比上一行早时（重连后重新建立对应关系等，误差是一次网络往返的量级）
 *   记成上一行的时间，按运行合并日志的顺序（@sfly/schema 的 run-log-order.ts）因此与读取方向无关。
 *   升级之前写入的行只有一个 `time`（当时记的是 Agent 时间）、没有 `agent_time`：读出时一律经
 *   {@link logLineView} / {@link normalizeLogRow}，按「只有 Agent 时间、控制面时间未记录」返回。
 * - 只追加。`tasks.log_bytes` 是已写入的字节数（= 文件大小），`tasks.log_seq` 是已写入的最大序号；
 *   序号不大于它的行视为重复而丢弃。secret 参数的值在写入前就替换成掩码，文件里没有明文。
 *
 * ## 进度
 * 只在 `tasks.progress` 保留最新值，不写文件；同样带两种时间，升级之前保存的值经 {@link taskProgressView} 读出。
 *
 * ## 上限（#18）
 * 单个任务的日志文件不超过 `limitBytes`（默认 200 MB）：放不下的第一行换成一行截断标记
 * （source `system`、level `warn`，序号沿用被丢弃的那一行），之后的行全部丢弃，`tasks.log_truncated` 置为 true。
 *
 * 日志和进度都不经过引擎的互斥锁（不改变运行状态）；同一个任务的追加按到达顺序串行执行。
 */

/** 一行日志（日志文件里的一行、SSE 推送的一项）。 */
export interface LogLineView {
	seq: number;
	/** 控制面时间（ISO）；升级之前写入的行没有记录，为 null。 */
	time: string | null;
	/** Agent 时间（ISO）；没有上报时为 null。 */
	agent_time: string | null;
	/** agent：Agent 自己写入的提示行（Agent 时间跳变，ADR 0018）；system：控制面自己写入的行（截断标记，#18）。 */
	source: "stdout" | "stderr" | "sdk" | "agent" | "system";
	level: "debug" | "info" | "warn" | "error";
	text: string;
}

/** 日志文件里新写入的行都带这个键；没有它的是升级之前写入的行。 */
const AGENT_TIME_KEY = Buffer.from('"agent_time":');

/**
 * 日志文件里解析出来的一行 → {@link LogLineView}。升级之前写入的行只有一个 `time`（Agent 时间）：
 * 按「只有 Agent 时间、控制面时间未记录」返回，字段顺序与新写入的行一致。
 */
export function logLineView(row: LogLineView | Omit<LogLineView, "agent_time">): LogLineView {
	if ("agent_time" in row) return row;
	const { seq, time, ...rest } = row;
	return { seq, time: null, agent_time: time, ...rest };
}

/**
 * 日志文件里的一行（不含换行符）→ 下载内容里的一行：新写入的行原样返回（不解析），
 * 升级之前写入的行补成两种时间都有的格式（{@link logLineView}）。文本里的引号在 JSON 里是转义的，
 * 所以原样出现的 `"agent_time":` 只可能是键。
 */
export function normalizeLogRow(row: Buffer): Buffer {
	if (row.length === 0 || row.includes(AGENT_TIME_KEY)) return row;
	return Buffer.from(JSON.stringify(logLineView(JSON.parse(row.toString("utf8")))));
}

/** 保存的进度 → 接口里的进度。升级之前保存的只有一个 `time`（Agent 时间）：控制面时间未记录。 */
export function taskProgressView(stored: TaskProgress): TaskProgressView {
	const { current, total, message, time } = stored;
	return "agent_time" in stored
		? { current, total, message, time, agent_time: stored.agent_time ?? null }
		: { current, total, message, time: null, agent_time: time };
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
	progress: TaskProgressView;
}

const SOURCES: Record<LogSource, LogLineView["source"]> = {
	[LogSource.UNSPECIFIED]: "stdout",
	[LogSource.STDOUT]: "stdout",
	[LogSource.STDERR]: "stderr",
	[LogSource.SDK]: "sdk",
	[LogSource.AGENT]: "agent",
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
/** 单个任务日志的默认上限：200 MB。 */
export const DEFAULT_LOG_LIMIT_BYTES = 200 * 1024 * 1024;

/** 缓存的任务状态数上限。 */
const CACHE_LIMIT = 1000;

interface TaskState {
	runId: string;
	chainInstanceId: string;
	nodeId: string;
	attempt: number;
	/** 任务的创建顺序（tasks.seq）。 */
	order: number;
	agentName: string | null;
	/** 相对数据目录。 */
	path: string;
	bytes: number;
	seq: number;
	/** 最后一行的控制面时间（毫秒）：没有行或最后一行是旧行时为 null，还没读过文件时为 undefined。 */
	lastTimeMs: number | null | undefined;
	truncated: boolean;
	secrets: string[];
}

/** 一个任务的日志文件概况（分页读取、下载用）。 */
export interface TaskLogInfo {
	runId: string;
	nodeId: string;
	attempt: number;
	/** 任务的创建顺序（tasks.seq）：按运行分页的游标用它代替任务 ID。 */
	order: number;
	/** 日志文件的绝对路径（还没有日志时文件可能不存在）。 */
	file: string;
	/** 已写入的字节数。 */
	bytes: number;
	/** 已写入的最大序号。 */
	seq: number;
	truncated: boolean;
}

export class TaskLogs {
	/** 新写入的日志（主题 = 任务 ID），写入文件之后发布。 */
	readonly lines = new Topics<LogChunk>();
	/** 进度更新（主题 = 运行 ID），写入数据库之后发布。 */
	readonly progress = new Topics<ProgressEvent>();

	#states = new Map<string, Promise<TaskState | undefined>>();
	#queues = new Map<string, Promise<void>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			dataDir: string;
			/** 单个任务日志的上限（字节），默认 {@link DEFAULT_LOG_LIMIT_BYTES}。 */
			limitBytes?: number;
		},
	) {}

	get #limit(): number {
		return this.deps.limitBytes ?? DEFAULT_LOG_LIMIT_BYTES;
	}

	/** 这条 Agent 消息是否由这里处理（日志、进度）。 */
	handles(message: AgentMessage): boolean {
		return message.body.case === "logs" || message.body.case === "progress";
	}

	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		// 收到的时刻在这里取（之后同一任务的写入要排队）：没有单调时钟读数时用它作控制面时间。
		const receivedAt = this.deps.clock.now();
		const controlPlaneTime: ControlPlaneTimeOf = (monotonicMs) =>
			conn.clock.controlPlaneTime(monotonicMs, receivedAt);
		if (message.body.case === "logs")
			await this.append(conn.name, message.body.value, controlPlaneTime);
		else if (message.body.case === "progress")
			await this.recordProgress(conn.name, message.body.value, controlPlaneTime);
	}

	/** 任务是否存在。 */
	async exists(taskId: string): Promise<boolean> {
		return (await this.#state(taskId)) !== undefined;
	}

	/** 任务日志文件的概况；任务不存在时为 undefined。 */
	async describe(taskId: string): Promise<TaskLogInfo | undefined> {
		const state = await this.#state(taskId);
		return state && this.#info(state);
	}

	/** 一次运行全部任务的日志文件概况（任务 ID → 概况），一次查询；不放进缓存，免得挤掉正在写入的任务。 */
	async describeRun(runId: string): Promise<Map<string, TaskLogInfo>> {
		const rows = await this.deps.db.select().from(tasks).where(eq(tasks.runId, runId));
		const infos = await Promise.all(
			rows.map(async (task) => {
				const state = (await this.#states.get(task.id)) ?? (await this.#stateOf(task));
				return [task.id, this.#info(state)] as const;
			}),
		);
		return new Map(infos);
	}

	#info(state: TaskState): TaskLogInfo {
		return {
			runId: state.runId,
			nodeId: state.nodeId,
			attempt: state.attempt,
			order: state.order,
			file: join(this.deps.dataDir, state.path),
			bytes: state.bytes,
			seq: state.seq,
			truncated: state.truncated,
		};
	}

	/**
	 * 追加一批日志（只接受任务所在 Agent 上报的）；同一任务的追加串行执行。
	 * `controlPlaneTime` 把一行的单调时钟读数折算成控制面时间。
	 */
	append(agentName: string, batch: LogBatch, controlPlaneTime: ControlPlaneTimeOf): Promise<void> {
		return this.#serial(batch.taskId, async () => {
			const state = await this.#stateFor(batch.taskId, agentName);
			if (!state || state.truncated) return;
			// 子流程实例可能在任务运行期间才创建，它声明的 secret 从此也要打码：每批都重新取。
			state.secrets = await this.#currentSecrets(state.runId);
			const file = join(this.deps.dataDir, state.path);
			if (state.lastTimeMs === undefined) state.lastTimeMs = await lastLineTimeMs(file);
			const lines: LogLineView[] = [];
			let text = "";
			let bytes = state.bytes;
			let seq = state.seq;
			let lastTimeMs = state.lastTimeMs;
			let truncated = false;
			for (const line of batch.lines) {
				const n = Number(line.seq);
				if (n <= seq) continue;
				seq = n;
				const timeMs = Math.max(
					controlPlaneTime(line.monotonicMs).getTime(),
					lastTimeMs ?? Number.NEGATIVE_INFINITY,
				);
				lastTimeMs = timeMs;
				const view: LogLineView = {
					seq: n,
					time: new Date(timeMs).toISOString(),
					agent_time: agentTime(line.timeUnixMs),
					source: SOURCES[line.source] ?? "stdout",
					level: LEVELS[line.level] ?? "info",
					text: maskSecrets(line.text, state.secrets),
				};
				let row = `${JSON.stringify(view)}\n`;
				if (bytes + Buffer.byteLength(row) > this.#limit) {
					// 放不下：这一行换成截断标记，之后的行全部丢弃。
					view.source = "system";
					view.level = "warn";
					view.text = `日志超过 ${formatBytes(this.#limit)} 上限，之后的内容已被截断`;
					row = `${JSON.stringify(view)}\n`;
					truncated = true;
				}
				lines.push(view);
				text += row;
				bytes += Buffer.byteLength(row);
				if (truncated) break;
			}
			if (lines.length === 0) return;
			await mkdir(dirname(file), { recursive: true });
			await appendFile(file, text);
			const offset = state.bytes;
			state.bytes = bytes;
			state.seq = seq;
			state.lastTimeMs = lastTimeMs;
			state.truncated = truncated;
			await this.deps.db
				.update(tasks)
				.set({
					logPath: state.path,
					logBytes: state.bytes,
					logSeq: state.seq,
					logTruncated: truncated,
				})
				.where(eq(tasks.id, batch.taskId));
			this.lines.publish(batch.taskId, { task_id: batch.taskId, lines, offset });
		});
	}

	/** 记录最新进度（只接受任务所在 Agent 上报的）；与同一任务的日志追加串行执行。 */
	recordProgress(
		agentName: string,
		progress: Progress,
		controlPlaneTime: ControlPlaneTimeOf,
	): Promise<void> {
		return this.#serial(progress.taskId, async () => {
			const state = await this.#stateFor(progress.taskId, agentName);
			if (!state) return;
			state.secrets = await this.#currentSecrets(state.runId);
			const value: TaskProgressView = {
				current: progress.current,
				total: progress.total ?? null,
				message: maskSecrets(progress.message, state.secrets),
				time: controlPlaneTime(progress.monotonicMs).toISOString(),
				agent_time: agentTime(progress.timeUnixMs),
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
			const line = logLineView(JSON.parse(bytes.subarray(pos, end).toString("utf8")));
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

	/** 一次运行当前的全部 secret 值（链实例可能在运行期间新增，每次现查）。 */
	async #currentSecrets(runId: string): Promise<string[]> {
		const [row] = await this.deps.db
			.select({ document: orchestrationVersions.document })
			.from(runs)
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(runs.id, runId));
		if (!row) return [];
		const chains = await this.deps.db
			.select({ chainId: chainInstances.chainId, params: chainInstances.params })
			.from(chainInstances)
			.where(eq(chainInstances.runId, runId));
		return secretValues(row.document, chains);
	}

	async #load(taskId: string): Promise<TaskState | undefined> {
		const [row] = await this.deps.db
			.select({ task: tasks })
			.from(tasks)
			.where(eq(tasks.id, taskId));
		return row && this.#stateOf(row.task);
	}

	async #stateOf(task: typeof tasks.$inferSelect): Promise<TaskState> {
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
			attempt: task.attempt,
			order: task.seq,
			agentName: task.agentName,
			path,
			bytes,
			seq: task.logSeq,
			// 第一次写入时才读（读分页、下载不需要它）。
			lastTimeMs: undefined,
			// 写完截断标记、数据库还没更新时控制面可能退出过：文件已到上限也算截断。
			truncated: task.logTruncated || bytes >= this.#limit,
			// 占位：写入前总会先经 #currentSecrets 刷新。
			secrets: [],
		};
	}
}

/** 日志文件最后一行的控制面时间（毫秒）；没有行或最后一行是旧行时为 null。 */
async function lastLineTimeMs(file: string): Promise<number | null> {
	const { lines } = await readLogPage(file, { direction: "backward", limit: 1, filter: {} });
	const time = lines[0]?.time;
	return time ? Date.parse(time) : null;
}

/** 把一条消息里的单调时钟读数折算成控制面时间（0 = 没有读数，取收到这条消息的时刻）。 */
export type ControlPlaneTimeOf = (monotonicMs: bigint) => Date;

/**
 * Agent 时间（Unix 毫秒）→ ISO。原样保存，不判断它是否合理（ADR 0018）：1970 年、2099 年都照记，
 * 超出能记录的范围时记成边界值（{@link recordableAgentTimeMs}）。0（没有上报）为 null。
 */
function agentTime(unixMs: bigint): string | null {
	if (unixMs === 0n) return null;
	return new Date(recordableAgentTimeMs(unixMs)).toISOString();
}

function formatBytes(n: number): string {
	if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
	if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
	return `${n} 字节`;
}
