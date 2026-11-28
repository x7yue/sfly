import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentMessage, type LogBatch, LogLevel, LogSource, type Progress } from "@sfly/proto";
import {
	isAlertLevel,
	type StoredOrchestrationDocument,
	type TaskProgressView,
} from "@sfly/schema";
import { eq, inArray } from "drizzle-orm";
import { recordableAgentTimeMs } from "../agents/agent-clock.js";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import {
	chainInstances,
	orchestrationVersions,
	runs,
	type TaskLogIssues,
	type TaskProgress,
	tasks,
} from "../db/schema.js";
import type { RunSecrets } from "../secrets/run-secrets.js";
import { Topics } from "../sse/topics.js";
import { clipChars } from "../util/text.js";
import { type LogMask, logMask, NO_LOG_MASK } from "./log-mask.js";
import { readLogPage } from "./log-pages.js";
import {
	declaresSecrets,
	NO_SECRETS,
	OVERSIZE_NOTICE,
	type SecretSet,
	SPLIT_CONTEXT_MAX_CHARS,
	secretValues,
} from "./secrets.js";

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
 *   折算出的时间比上一行早不到 2 秒（重连后重新建立对应关系等，误差是一次网络往返的量级）时记成上一行的时间；
 *   早得更多说明折算出了错（例如上一行偏到了未来），保留折算出的时间，免得之后的行都停在那个时刻。
 *   升级之前写入的行只有一个 `time`（当时记的是 Agent 时间）、没有 `agent_time`：读出时一律经
 *   {@link logLineView} / {@link normalizeLogRow}，按「只有 Agent 时间、控制面时间未记录」返回。
 * - 只追加。`tasks.log_bytes` 是已写入的字节数（= 文件大小），`tasks.log_seq` 是最后一行的序号。
 *   secret 参数的值在写入前就替换成掩码，文件里没有明文。
 *
 * ## 序号
 * 文件里每行的序号（`seq`）逐行递增，分页、SSE 续传和画布去重都按它。写进文件的行有两个来源：
 * - Agent 上报的行带 Agent 自己的序号（任务内从 1 递增）。Agent 序号不大于 `tasks.log_agent_seq`
 *   （已写入的最大 Agent 序号）的行视为重复而丢弃；写入的行的序号比上一行多出的部分等于 Agent 序号多出的部分，
 *   所以 Agent 断线排队时丢弃的行在文件里仍显示为序号缺口。
 * - 控制面自己写的行（source `system`，{@link TaskLogs.appendSystem}）取上一行的序号加 1，不占用 Agent 序号：
 *   之后 Agent 上报的行照常写入。它的控制面时间取写入时的时钟，同样按上面的 2 秒规则与上一行比较，
 *   所以按运行合并读取（`run-log-pages.ts`）时它和 Agent 上报的行遵守同一个「时间随序号不减」。
 * 没有控制面写的行时，两种序号相同。
 *
 * ## 进度
 * 只在 `tasks.progress` 保留最新值，不写文件；同样带两种时间，升级之前保存的值经 {@link taskProgressView} 读出。
 *
 * ## WARN / ERROR（`tasks.log_issues`，规格 #344）
 * 写进文件的 WARN / ERROR 行在写入时计数，并记下最近一条的级别、控制面时间和正文（打码之后，截到
 * {@link LOG_ISSUE_TEXT_CHARS} 个字符），与字节数、序号在同一次更新里写库。关注项按它判断「最近 10 分钟内有 WARN / ERROR」，
 * 不扫日志文件。截断标记本身是一行 WARN，计入；之后的行不再写入，也不再计数。
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

/**
 * 保存的进度 → 接口里的进度，说明按 `secrets`（运行此刻的全部 secret 值）打码。升级之前保存的只有一个 `time`
 * （Agent 时间）：控制面时间未记录。
 */
export function taskProgressView(stored: TaskProgress, secrets: SecretSet): TaskProgressView {
	const { current, total, time } = stored;
	// 写入时已经按那一刻的 secret 打过码；读取时再打一遍，之后才创建的子流程带来的 secret 也算（运行视图和 Agent 列表口径一样）。
	const message = secrets.mask(stored.message);
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
/** `tasks.log_issues` 里最近一条 WARN / ERROR 的正文最多记多少个字符（Unicode 码点）。 */
export const LOG_ISSUE_TEXT_CHARS = 500;

/** 缓存的任务状态数上限。 */
const CACHE_LIMIT = 1000;

/** 往有上限的缓存里记一项（超过上限丢掉最早的）。 */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
	cache.set(key, value);
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

interface TaskState {
	runId: string;
	chainInstanceId: string;
	nodeId: string;
	attempt: number;
	order: number;
	agentName: string | null;
	/** 相对数据目录。 */
	path: string;
	bytes: number;
	/**
	 * 数据库记下的已写入的字节数（`tasks.log_bytes`）：文件不会比它短（写入是先追加文件、再更新数据库，每一批都是整行），
	 * 比它短就是文件被删了或截短了（保留期清理、人为）。读文件时用它认出「文件不见了、变短了」（#669）。
	 */
	recordedBytes: number;
	/** 文件里最后一行的序号。 */
	seq: number;
	/** 已写入的最大 Agent 序号。 */
	agentSeq: number;
	/** 最后一行的控制面时间（毫秒）：没有行或最后一行是旧行时为 null，还没读过文件时为 undefined。 */
	lastTimeMs: number | null | undefined;
	truncated: boolean;
	/** 已写入的 WARN / ERROR（`tasks.log_issues`）；还没有时为 null。 */
	issues: TaskLogIssues | null;
	/** 这个任务的日志里是不是已经写过「值集合太大」的说明（{@link OVERSIZE_NOTICE}）；控制面重启之后重新算，会再写一行。 */
	oversizeNoted: boolean;
}

/**
 * 一行折算出的控制面时间比上一行早不到这么多（毫秒）时，记成上一行的时间。折算误差（重连后重新建立对应关系等）
 * 是一次网络往返的量级，远小于 2 秒；抹平它让同一任务内的时间随序号不减。早得更多说明折算出了错（例如上一行
 * 偏到了未来）：这时也记成上一行的时间，之后的行会全部停在那个时刻，所以保留折算出的时间。
 * 值与 ADR 0018 里「偏差不到 2 秒视为一致」（页面提示时钟偏差的阈值）相同，但两者是独立的决定：
 * 调整那个阈值不应该改变日志怎么记。
 */
const TIME_REGRESSION_CLAMP_MS = 2000;

/** 一个任务的日志文件概况（分页读取、下载用）。 */
export interface TaskLogInfo {
	runId: string;
	nodeId: string;
	attempt: number;
	/** 任务的创建顺序（tasks.seq）：按运行分页的游标用它代替任务 ID。 */
	order: number;
	/** 日志文件的绝对路径（还没有日志时文件可能不存在）。 */
	file: string;
	/** 列出任务那一刻已写入的字节数：按运行读取时每个任务只读到这里。 */
	bytes: number;
	/**
	 * 数据库记下的已写入的字节数：文件不会比它短，比它短（或者不存在）说明文件被删了或截短了；有行写入过（`seq > 0`）而文件不存在
	 * 也是这样。下载用它认出日志已经不全了（#669）。
	 */
	recordedBytes: number;
	/** 最后一行的序号（与 bytes 是同一刻的）。 */
	seq: number;
	truncated: boolean;
}

export class TaskLogs {
	/** 新写入的日志（主题 = 任务 ID），写入文件之后发布。 */
	readonly lines = new Topics<LogChunk>();
	/** 同样的日志按运行发布（主题 = 运行 ID）：按运行的实时推送靠它覆盖订阅之后才产生的任务。 */
	readonly runLines = new Topics<LogChunk>();
	/** 进度更新（主题 = 运行 ID），写入数据库之后发布。 */
	readonly progress = new Topics<ProgressEvent>();

	#states = new Map<string, Promise<TaskState | undefined>>();
	#queues = new Map<string, Promise<void>>();
	/** 运行 ID → 它绑定的版本 ID、是不是写入时打码的（{@link TaskLogs.runSecrets} 用）。 */
	#runVersions = new Map<string, { versionId: string; maskedOnWrite: boolean }>();
	/** 版本 ID → 它的文档（声明了 secret 参数时），没有声明为 undefined。 */
	#secretVersions = new Map<string, StoredOrchestrationDocument | undefined>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			dataDir: string;
			/** 写入时打码的运行的加密副本（#505）。 */
			runSecrets: Pick<RunSecrets, "admitted" | "committedSet">;
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
			recordedBytes: state.recordedBytes,
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
			await this.#write(
				batch.taskId,
				state,
				batch.lines.map((line) => ({
					agentSeq: Number(line.seq),
					timeMs: controlPlaneTime(line.monotonicMs).getTime(),
					agent_time: agentTime(line.timeUnixMs),
					source: SOURCES[line.source] ?? "stdout",
					level: LEVELS[line.level] ?? "info",
					text: line.text,
					context: contextOf(line),
				})),
			);
		});
	}

	/**
	 * 控制面自己写一行日志（source `system`，控制面时间取当前时钟）：ctx.notify 的告警和投递结果
	 * （docs/SEMANTICS.md §4.2）。任何任务都可以写；序号接在最后一行后面，不占用 Agent 序号。
	 * 与同一任务的其他写入串行执行；任务不存在、日志已被截断时什么也不写。
	 */
	appendSystem(taskId: string, level: LogLineView["level"], text: string): Promise<void> {
		return this.#serial(taskId, async () => {
			const state = await this.#state(taskId);
			if (!state || state.truncated) return;
			await this.#write(taskId, state, [
				{
					agentSeq: null,
					timeMs: this.deps.clock.now().getTime(),
					agent_time: null,
					source: "system",
					level,
					text,
				},
			]);
		});
	}

	/**
	 * 把若干行追加到任务的日志文件，按「序号」一节分配序号：Agent 序号不大于已写入的最大 Agent 序号的行视为重复丢弃，
	 * 控制面写的行（`agentSeq` 为 null）接在最后一行后面；控制面时间比上一行早不到 2 秒时记成上一行的时间
	 * （{@link TIME_REGRESSION_CLAMP_MS}，两种来源的行一样）；secret 的值写入前打码；
	 * 放不下的第一行换成截断标记，之后的行全部丢弃（#18）。写完按任务和按运行各发布一次。
	 * 调用方在 {@link TaskLogs.#serial} 里调用。
	 */
	async #write(taskId: string, state: TaskState, written: readonly NewLine[]): Promise<void> {
		// 子流程实例可能在任务运行期间才创建，它声明的 secret 从此也要打码：每批都重新取。只在这一次写入里用，不留在任务状态上：
		// 值集合（和它的自动机）归值集合的缓存管（按字节数限大小，{@link secretSetOf}），任务状态留着它就管不住了。
		// 写入时打码的运行，加密副本已经删除（#505）：Agent 迟到的行丢弃、计数；控制面自己写的行（投递结果等）照常写，它们不含原值。
		if (written.every((e) => e.agentSeq === null)) {
			await this.#writeMasked(taskId, state, written, await this.controlPlaneSecrets(state.runId));
			return;
		}
		await this.withRunSecrets(state.runId, (secrets) =>
			this.#writeMasked(taskId, state, written, secrets),
		);
	}

	async #writeMasked(
		taskId: string,
		state: TaskState,
		written: readonly NewLine[],
		secrets: SecretSet,
	): Promise<void> {
		// 这次运行的值集合大到认不出每一处出现，所有文字都整段盖住（SecretSet.oversize）：在这个任务的日志里留一行平台写的说明
		// （不含值），用户才知道为什么全是掩码。写在「值集合变大之后这个任务第一次写日志」的那一批的最前面，每个任务一次，
		// 时间取这一批里第一行**真正写入**的行的时间（Agent 序号不大于已写入的最大序号的是重发的旧行，会被丢掉，不算；
		// 取了旧行的时间，说明这一行的时间会倒退）；这一批没有要写入的行（全是重发的旧行）就等下一批。打码时只有它原样放行。
		// 在那之前写下的行、从不写日志的任务没有这一行。
		const firstWritten = written.find((e) => e.agentSeq === null || e.agentSeq > state.agentSeq);
		const notice = secrets.oversize && !state.oversizeNoted && firstWritten !== undefined;
		let entries = written;
		if (notice) {
			entries = [
				{
					agentSeq: null,
					timeMs: firstWritten.timeMs,
					agent_time: null,
					source: "system",
					level: "warn",
					text: OVERSIZE_NOTICE,
				},
				...entries,
			];
		}
		const file = join(this.deps.dataDir, state.path);
		if (state.lastTimeMs === undefined) state.lastTimeMs = await lastLineTimeMs(file);
		const lines: LogLineView[] = [];
		let text = "";
		let bytes = state.bytes;
		let seq = state.seq;
		let agentSeq = state.agentSeq;
		let lastTimeMs = state.lastTimeMs;
		let issues = state.issues;
		let truncated = false;
		for (const { agentSeq: lineAgentSeq, timeMs: converted, context, ...entry } of entries) {
			if (lineAgentSeq === null) seq += 1;
			else if (lineAgentSeq <= agentSeq) continue;
			else {
				seq += lineAgentSeq - agentSeq;
				agentSeq = lineAgentSeq;
			}
			const timeMs =
				lastTimeMs != null &&
				converted < lastTimeMs &&
				lastTimeMs - converted < TIME_REGRESSION_CLAMP_MS
					? lastTimeMs
					: converted;
			lastTimeMs = timeMs;
			const view: LogLineView = {
				seq,
				time: new Date(timeMs).toISOString(),
				...entry,
				text: context
					? secrets.maskInContext(entry.text, context.before, context.after)
					: secrets.mask(entry.text),
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
			if (isAlertLevel(view.level)) {
				issues = {
					count: (issues?.count ?? 0) + 1,
					level: view.level,
					at: view.time as string,
					text: clipChars(view.text, LOG_ISSUE_TEXT_CHARS),
				};
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
		state.agentSeq = agentSeq;
		state.lastTimeMs = lastTimeMs;
		state.truncated = truncated;
		if (notice) state.oversizeNoted = true;
		const issuesChanged = issues !== state.issues;
		state.issues = issues;
		await this.deps.db
			.update(tasks)
			.set({
				logPath: state.path,
				logBytes: state.bytes,
				logSeq: state.seq,
				logAgentSeq: state.agentSeq,
				logTruncated: truncated,
				...(issuesChanged && { logIssues: issues }),
			})
			.where(eq(tasks.id, taskId));
		state.recordedBytes = state.bytes;
		const chunk = { task_id: taskId, lines, offset };
		this.lines.publish(taskId, chunk);
		this.runLines.publish(state.runId, chunk);
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
			const value = await this.withRunSecrets(state.runId, async (secrets) => {
				const value: TaskProgressView = {
					current: progress.current,
					total: progress.total ?? null,
					message: secrets.mask(progress.message),
					time: controlPlaneTime(progress.monotonicMs).toISOString(),
					agent_time: agentTime(progress.timeUnixMs),
				};
				await this.deps.db
					.update(tasks)
					.set({ progress: value })
					.where(eq(tasks.id, progress.taskId));
				return value;
			});
			if (!value) return;
			this.progress.publish(state.runId, {
				run_id: state.runId,
				chain_instance_id: state.chainInstanceId,
				node_id: state.nodeId,
				task_id: progress.taskId,
				progress: value,
			});
		});
	}

	/** 日志文件尾部最多 500 行中序号大于 `afterSeq` 的行；正文读取时按这次运行此刻的 secret 值再打一遍码（{@link TaskLogs.logMask}）。 */
	async tail(taskId: string, afterSeq = 0): Promise<LogChunk> {
		const state = await this.#state(taskId);
		const empty = { task_id: taskId, lines: [], offset: state?.bytes ?? 0 };
		if (!state) return empty;
		const mask = await this.logMask(state.runId);
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
			lines: kept.map((f) => mask.line(f.line)),
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

	/**
	 * 一条上报的准入和写入：用写进库之前打码用的值集合做 `write`（写入在里面做完），返回它的结果。写入时打码的运行（#505）是它加密副本里
	 * 的原值集合，拿着运行的闸门做（`RunSecrets.admitted`）：副本已经删除时这条上报丢弃、计数，返回 undefined；删除副本等 `write`
	 * 做完。之前的运行是此刻各链实例里 secret 参数的值（{@link runSecretValues}）。写日志、进度、动作、通知、指标都用它。运行绑定的
	 * 版本、版本的内容都不会变，所以「这个版本有没有声明 secret 参数」按版本缓存：没有声明的旧运行之后每次都不用再查库。
	 */
	async withRunSecrets<T>(
		runId: string,
		write: (secrets: SecretSet) => Promise<T>,
	): Promise<T | undefined> {
		const run = await this.#run(runId);
		if (!run) return write(NO_SECRETS);
		if (run.maskedOnWrite) return this.deps.runSecrets.admitted(this.deps.db, runId, write);
		return write(await this.#readTimeSecrets(runId, run.versionId));
	}

	/** 控制面自己写的行用的值集合：副本已经删除时什么都不打（这些行不含原值），不算迟到的上报。 */
	async controlPlaneSecrets(runId: string): Promise<SecretSet> {
		const run = await this.#run(runId);
		if (!run) return NO_SECRETS;
		if (run.maskedOnWrite)
			return (await this.deps.runSecrets.committedSet(this.deps.db, runId)) ?? NO_SECRETS;
		return this.#readTimeSecrets(runId, run.versionId);
	}

	/** 读取时打码用的值集合：写入时打码的运行已经打过，什么都不用做；之前的运行照旧按此刻的值。 */
	async readSecrets(runId: string): Promise<SecretSet> {
		const run = await this.#run(runId);
		if (!run || run.maskedOnWrite) return NO_SECRETS;
		return this.#readTimeSecrets(runId, run.versionId);
	}

	/** 读日志时用的打码（log-mask.ts）：没有要打码的值时读取方什么都不用做。 */
	async logMask(runId: string): Promise<LogMask> {
		return logMask(await this.readSecrets(runId));
	}

	async #readTimeSecrets(runId: string, versionId: string): Promise<SecretSet> {
		const document = await this.#secretDocument(versionId);
		if (!document) return NO_SECRETS;
		return (await runSecretValues(this.deps.db, [{ runId, document }])).get(runId) ?? NO_SECRETS;
	}

	async #run(runId: string): Promise<{ versionId: string; maskedOnWrite: boolean } | undefined> {
		const known = this.#runVersions.get(runId);
		if (known) return known;
		const [row] = await this.deps.db
			.select({ versionId: runs.orchestrationVersionId, maskedOnWrite: runs.maskedOnWrite })
			.from(runs)
			.where(eq(runs.id, runId));
		if (row) remember(this.#runVersions, runId, row);
		return row;
	}

	/** 版本的文档，只在它声明了 secret 参数时返回（缓存）；没有声明时为 undefined。 */
	async #secretDocument(versionId: string): Promise<StoredOrchestrationDocument | undefined> {
		if (this.#secretVersions.has(versionId)) return this.#secretVersions.get(versionId);
		const [version] = await this.deps.db
			.select({ document: orchestrationVersions.document })
			.from(orchestrationVersions)
			.where(eq(orchestrationVersions.id, versionId));
		const document = version && declaresSecrets(version.document) ? version.document : undefined;
		remember(this.#secretVersions, versionId, document);
		return document;
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
			recordedBytes: task.logBytes,
			seq: task.logSeq,
			agentSeq: task.logAgentSeq,
			// 第一次写入时才读（读分页、下载不需要它）。
			lastTimeMs: undefined,
			// 写完截断标记、数据库还没更新时控制面可能退出过：文件已到上限也算截断。
			truncated: task.logTruncated || bytes >= this.#limit,
			issues: task.logIssues,
			oversizeNoted: false,
		};
	}
}

/**
 * 要写进文件的一行（还没有序号）：`agentSeq` 是 Agent 上报的序号，控制面自己写的行为 null；
 * `timeMs` 是折算出（或控制面取到）的控制面时间，写入时再按 2 秒规则与上一行比较。
 */
type NewLine = Omit<LogLineView, "seq" | "time"> & {
	agentSeq: number | null;
	timeMs: number;
	/** 被拆开的超长行的一段带的上下文（只用来打码，不显示、不保存）；没有拆开的行没有。 */
	context?: { before: string; after: string };
};

/**
 * 一行日志带的上下文（`LogLine.before` / `after`）：都是空串时没有；任何一段超过上限（不是正常的 Agent 发的）按没带处理，
 * 不报错、不断流。上下文只在这一次写入里用来打码，不进文件、不进任何日志和错误信息。
 */
function contextOf(line: { before: string; after: string }): NewLine["context"] {
	const { before, after } = line;
	if (before === "" && after === "") return undefined;
	if (before.length > SPLIT_CONTEXT_MAX_CHARS || after.length > SPLIT_CONTEXT_MAX_CHARS) {
		return undefined;
	}
	return { before, after };
}

/** 日志文件最后一行的控制面时间（毫秒）；没有行或最后一行是旧行时为 null。 */
async function lastLineTimeMs(file: string): Promise<number | null> {
	// 只取最后一行的时间，不用正文，不需要打码。
	const { lines } = await readLogPage(file, {
		direction: "backward",
		limit: 1,
		filter: {},
		mask: NO_LOG_MASK,
	});
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

/**
 * 这些运行此刻的全部 secret 值（{@link secretValues}），按运行 ID：`document` 是运行绑定的版本，链实例可能在运行期间新增，
 * 所以每次现查，整批一条查询。`db` 可以是事务（在事务里读时）。写日志、动作时打码（{@link TaskLogs.runSecrets}）、
 * 关注项的异常原因、Agent 列表的进度和正在做的动作都用它，和运行视图同一个算法。
 */
export async function runSecretValues(
	db: Db | Tx,
	items: ReadonlyArray<{ runId: string; document: StoredOrchestrationDocument }>,
): Promise<Map<string, SecretSet>> {
	const secrets = new Map<string, SecretSet>();
	if (items.length === 0) return secrets;
	const chains = await db
		.select({
			runId: chainInstances.runId,
			chainId: chainInstances.chainId,
			params: chainInstances.params,
		})
		.from(chainInstances)
		.where(
			inArray(
				chainInstances.runId,
				items.map((r) => r.runId),
			),
		);
	for (const { runId, document } of items) {
		secrets.set(
			runId,
			secretValues(
				document,
				chains.filter((c) => c.runId === runId),
			),
		);
	}
	return secrets;
}
