import type { LogChunk, LogLineView, LogPage } from "@sfly/schema";

/**
 * 一个任务已加载的日志（纯逻辑，单测见 log-buffer.test.ts）：先读最后一页历史（服务端按筛选条件过滤），
 * 再用 `after_seq` 接上实时流（浏览器按同样的条件过滤），往前翻页补更早的行。
 * 不变式：已加载的行在日志文件里是连续的一段 [start, end)（筛掉的行除外），按序号排列、不重复。
 */

/** 已加载的一行及其在日志文件中的字节偏移。 */
export type LoadedLine = LogLineView & { offset: number };

export interface LogBuffer {
	/** 符合筛选条件的行（按序号），最多 maxLines 行。 */
	lines: LoadedLine[];
	/** 已加载部分在文件中的起点：往前翻页用 `before=start`。 */
	start: number;
	/** 已加载部分在文件中的终点：实时流的下一批应从这里开始。 */
	end: number;
	hasOlder: boolean;
	loaded: boolean;
	truncated: boolean;
	expired: boolean;
	/** 读最后一页时已写入的最大序号：实时流从它之后接上。 */
	lastSeq: number;
}

/** 浏览器里最多保留的行数：实时追加超过时丢掉最早的行（仍可往前翻页重新加载）。 */
export const MAX_LOADED_LINES = 5000;

/** 控制面写满单个任务的日志上限后追加的截断标记（来源 system）。 */
export const isTruncationMarker = (line: Pick<LogLineView, "source">) => line.source === "system";

export const emptyBuffer: LogBuffer = {
	lines: [],
	start: 0,
	end: 0,
	hasOlder: false,
	loaded: false,
	truncated: false,
	expired: false,
	lastSeq: 0,
};

const encoder = new TextEncoder();
/** 一行在日志文件中占的字节数（文件是 JSONL，与控制面写入的格式一致）。 */
const lineBytes = (line: LogLineView) => encoder.encode(`${JSON.stringify(line)}\n`).length;

/** 按序号合并两组行（去重，结果按序号排序）。 */
export function mergeLines<L extends LogLineView>(a: L[], b: L[]): L[] {
	if (b.length === 0) return a;
	if (a.length === 0) return b;
	// 常见情况：新行都在已有行之后，或者更早的一页都在已有行之前。
	if ((b[0] as L).seq > (a.at(-1) as L).seq) return [...a, ...b];
	if ((b.at(-1) as L).seq < (a[0] as L).seq) return [...b, ...a];
	const bySeq = new Map<number, L>();
	for (const line of a) bySeq.set(line.seq, line);
	for (const line of b) bySeq.set(line.seq, line);
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** 最后一页历史（第一次加载或筛选条件变化后）。 */
export function fromLatestPage(page: LogPage): LogBuffer {
	return {
		lines: page.lines,
		start: page.start,
		end: page.end,
		hasOlder: page.start > 0,
		loaded: true,
		truncated: page.truncated,
		expired: page.expired,
		lastSeq: page.last_seq,
	};
}

/** 往前翻的一页（`before=buffer.start`）。 */
export function withOlderPage(buffer: LogBuffer, page: LogPage): LogBuffer {
	return {
		...buffer,
		lines: mergeLines(page.lines, buffer.lines),
		start: page.start,
		hasOlder: page.start > 0,
	};
}

/**
 * 实时流推送的一批行。`accept` 是筛选条件；超过 maxLines 时丢掉最早的行。
 * 这一批没有接在已加载部分之后（读完历史到连上实时流、或断线重连期间写入太多）时，
 * 丢掉已加载的行，从这一批往前翻页，保证已加载的行在文件里是连续的。
 */
export function withLive(
	buffer: LogBuffer,
	chunk: LogChunk,
	accept: (line: LogLineView) => boolean,
	maxLines = MAX_LOADED_LINES,
): LogBuffer {
	if (chunk.lines.length === 0) return buffer;
	let offset = chunk.offset;
	const fresh: LoadedLine[] = [];
	for (const line of chunk.lines) {
		if (accept(line)) fresh.push({ ...line, offset });
		offset += lineBytes(line);
	}
	const gap = chunk.offset > buffer.end;
	let next: LogBuffer = {
		...buffer,
		lines: mergeLines(gap ? [] : buffer.lines, fresh),
		start: gap ? chunk.offset : buffer.start,
		end: Math.max(buffer.end, offset),
		hasOlder: gap || buffer.hasOlder,
		truncated: buffer.truncated || chunk.lines.some(isTruncationMarker),
	};
	if (next.lines.length > maxLines) {
		const kept = next.lines.slice(-maxLines);
		next = { ...next, lines: kept, start: (kept[0] as LoadedLine).offset, hasOlder: true };
	}
	return next;
}
