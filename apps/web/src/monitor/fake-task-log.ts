import type { LogChunk, LogLineView, LogPage } from "@sfly/schema";
import { FakeLive, FakePages } from "#/lib/fake-ports";
import type { TaskLogPorts } from "./task-log-reader";

/**
 * 内存里的假日志文件，给 task-log-reader 的测试当适配器：分页（最后一页、`before`、`after`、定位的 `at`）、
 * 级别筛选和实时流按控制面的规则回答；请求（`pages.reads`）和连接（`live.connections`）都记下来供测试断言，
 * 回答可以扣住（`pages.hold`）、之后再放（`pages.release()`）。
 * 第 n 行（n 从 1 起）的控制面时间是 2026-01-01 0 点 0 分 n 秒。
 */

export type FileLine = LogLineView & { offset: number };

export interface FakeTaskLogOptions {
	/** 每页扫描的行数（`limit`）。 */
	pageSize: number;
	/** 请求带的级别筛选，空是不筛选：分页只返回符合的行，实时流也只收符合的行。 */
	levels?: readonly LogLineView["level"][];
	/** 第 seq 行的级别，默认都是 info。 */
	levelOf?: (seq: number) => LogLineView["level"];
}

export type Position = Parameters<TaskLogPorts["readPage"]>[0];

const encoder = new TextEncoder();
const bytes = (line: LogLineView) => encoder.encode(`${JSON.stringify(line)}\n`).length;

export const secondsIn = (seq: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();

export function logLine(
	seq: number,
	level: LogLineView["level"] = "info",
	source: LogLineView["source"] = "stdout",
): LogLineView {
	return {
		seq,
		time: secondsIn(seq),
		agent_time: new Date(Date.UTC(2027, 8, 6, 0, 0, seq)).toISOString(),
		source,
		level,
		text: `line ${seq}`,
	};
}

export class FakeTaskLog implements TaskLogPorts {
	readonly lines: FileLine[] = [];
	size = 0;
	readonly pages = new FakePages<Position, LogPage>((position) => this.pageAt(position));
	readonly live = new FakeLive<number, (chunk: LogChunk) => void>();

	constructor(
		lines: number,
		private readonly options: FakeTaskLogOptions,
	) {
		this.write(lines);
	}

	readPage = this.pages.read;
	subscribeLive = this.live.connect;
	accepts = (line: LogLineView) =>
		!this.options.levels?.length || this.options.levels.includes(line.level);

	/** 往文件末尾写 n 行，不推给实时流（连接断开期间、或推送还在路上写下的行）。 */
	write(n: number) {
		const next = (this.lines.at(-1)?.seq ?? 0) + 1;
		this.writeLines(
			Array.from({ length: n }, (_, i) => logLine(next + i, this.options.levelOf?.(next + i))),
		);
	}

	/** 写入这些行（序号要接在文件最后一行之后），不推给实时流。 */
	writeLines(lines: LogLineView[]) {
		for (const line of lines) {
			this.lines.push({ ...line, offset: this.size });
			this.size += bytes(line);
		}
	}

	/** 把文件里第 from 到第 to 行作为一批推给实时流，`offset` 是第一行的偏移。 */
	push(from: number, to: number) {
		const first = this.lines[from - 1];
		if (!first) throw new Error(`没有第 ${from} 行`);
		this.emit({
			task_id: "t",
			lines: this.lines.slice(from - 1, to).map(({ offset: _, ...line }) => line),
			offset: first.offset,
		});
	}

	/** 写 n 行并推给实时流。 */
	append(n: number) {
		const first = this.lines.length + 1;
		this.write(n);
		this.push(first, first + n - 1);
	}

	/** 写入这些行并推给实时流。 */
	appendLines(lines: LogLineView[]) {
		const first = this.lines.length + 1;
		this.writeLines(lines);
		this.push(first, this.lines.length);
	}

	/** 把一批原样推给所有还连着的实时流。 */
	emit(chunk: LogChunk) {
		this.live.push((onChunk) => onChunk(chunk));
	}

	/** 文件里第 index 行（从 0 起）的偏移；超出时是文件大小。 */
	offsetOf(index: number) {
		return this.lines[index]?.offset ?? this.size;
	}

	private pageAt(position: Position): LogPage {
		const n = this.lines.length;
		const size = this.options.pageSize;
		let from: number;
		let to: number;
		let locate: LogPage["locate"] = null;
		if (position.at !== undefined) {
			// 那一刻之前的行都早于它：前后各取一半，靠近开头或末尾时由另一侧补满。
			const at = position.at;
			const k = this.lines.findIndex((l) => l.time !== null && l.time >= at);
			const moment = k < 0 ? n : k;
			from = Math.max(0, Math.min(moment - Math.floor(size / 2), n - size));
			to = Math.min(n, from + size);
			locate = {
				at_offset: this.offsetOf(moment),
				exact_seq: this.lines[moment]?.time === at ? (this.lines[moment] as FileLine).seq : null,
			};
		} else if (position.before !== undefined) {
			const before = position.before;
			to = this.lines.findIndex((l) => l.offset >= before);
			if (to < 0) to = n;
			from = Math.max(0, to - size);
		} else if (position.after !== undefined) {
			const after = position.after;
			from = this.lines.findIndex((l) => l.offset >= after);
			if (from < 0) from = n;
			to = Math.min(n, from + size);
		} else {
			from = Math.max(0, n - size);
			to = n;
		}
		return {
			task_id: "t",
			lines: this.lines.slice(from, to).filter(this.accepts),
			start: this.offsetOf(from),
			end: to >= n ? this.size : this.offsetOf(to),
			size: this.size,
			last_seq: this.lines.at(-1)?.seq ?? 0,
			truncated: false,
			expired: false,
			locate,
		};
	}
}
