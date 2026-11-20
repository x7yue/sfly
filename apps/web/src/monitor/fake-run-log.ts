import type { LogLineView, RunLogLine, RunLogPage } from "@sfly/schema";
import { FakeLive, FakePages } from "#/lib/fake-ports";
import type { RunLogPorts } from "./run-log-reader";

/**
 * 内存里的假的合并日志，给 run-log-reader 的测试当适配器。历史按合并日志的顺序给定（`lines`，测试自己排好），
 * 分页按它回答：最新一页是最后 `pageSize` 行，游标是这一页第一行的下标，往前翻读它之前的 `pageSize` 行；
 * 每页扫描 `pageSize` 行，级别筛选之后可以一行都没有（筛选很少匹配时）。每读一次最新一页，`live_after` 换一个新的值
 * （`live-1`、`live-2`……），测试能看出实时推送是从哪一次读的位置接上的。
 * 实时推送：`append` 写进历史末尾并推出去；`emit` 只推不写（晚到的行、重复的行）；`reload` 让读取器重新读。
 * 要构造控制面不会给出的页时，用 `pages.replyNext(page)`。
 */

/** 任务 task 的第 seq 行，控制面时间是第 ms 毫秒（默认等于 seq）。每个任务是主链上的一个节点，节点的位置按任务名字母顺序。 */
export function runLine(
	task: string,
	seq: number,
	ms = seq,
	source: RunLogLine["source"] = "stdout",
	level: LogLineView["level"] = "info",
): RunLogLine {
	const t0 = Date.UTC(2026, 0, 1);
	return {
		seq,
		time: new Date(t0 + ms).toISOString(),
		agent_time: null,
		source,
		level,
		text: `${task} ${seq}`,
		task_id: task,
		chain_instance_id: "main",
		subflow: null,
		node_id: task,
		attempt: 1,
		chain_depth: 0,
		chain_started_at: new Date(t0).toISOString(),
		node_index: task.charCodeAt(0) - 97,
		task_started_at: new Date(t0).toISOString(),
	};
}

/** 控制面返回的一页：游标是不透明字符串，这里用能看出是哪一页的。 */
export function runPage(
	lines: RunLogLine[],
	before: string,
	{ reachedStart = false, liveAfter = "live" } = {},
): RunLogPage {
	return {
		run_id: "r",
		lines,
		before,
		after: `after ${before}`,
		reached_start: reachedStart,
		reached_end: true,
		live_after: liveAfter,
		truncated_tasks: [],
		expired: false,
	};
}

export interface FakeRunLogOptions {
	/** 每页扫描的行数。 */
	pageSize: number;
	/** 请求带的级别筛选，空是不筛选：分页和实时推送只给符合的行。 */
	levels?: readonly LogLineView["level"][];
}

export type RunPosition = Parameters<RunLogPorts["readPage"]>[0];
type LiveHandlers = Parameters<RunLogPorts["subscribeLive"]>[1];

export class FakeRunLog implements RunLogPorts {
	/** 为 true 时，最新一页读到的是「运行已超过保留期」的空页。 */
	expired = false;
	readonly pages = new FakePages<RunPosition, RunLogPage>((position) => this.pageAt(position));
	readonly live = new FakeLive<string, LiveHandlers>();
	private latestReads = 0;

	constructor(
		readonly lines: RunLogLine[],
		private readonly options: FakeRunLogOptions,
	) {}

	readPage = this.pages.read;
	subscribeLive = this.live.connect;

	private accepts = (line: LogLineView) =>
		!this.options.levels?.length || this.options.levels.includes(line.level);

	/** 写进历史末尾（序号和排序键都接在最后一行之后），并推给实时推送。 */
	append(lines: RunLogLine[]) {
		this.lines.push(...lines);
		this.emit(lines);
	}

	/** 只推给实时推送，不写进历史。 */
	emit(lines: RunLogLine[]) {
		const matching = lines.filter(this.accepts);
		if (matching.length > 0) this.live.push((h) => h.onLines(matching));
	}

	/** 控制面让读取器从最新一页重新读。 */
	reload() {
		this.live.push((h) => h.onReload());
	}

	private pageAt({ before }: RunPosition): RunLogPage {
		const end = before === undefined ? this.lines.length : Number(before);
		const start = Math.max(0, end - this.options.pageSize);
		const latest = before === undefined;
		if (latest) this.latestReads++;
		const expired = latest && this.expired;
		return {
			...runPage(expired ? [] : this.lines.slice(start, end).filter(this.accepts), String(start), {
				reachedStart: start === 0,
				liveAfter: `live-${this.latestReads}`,
			}),
			expired,
		};
	}
}
