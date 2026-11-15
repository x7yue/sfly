import { type FileHandle, open } from "node:fs/promises";
import { type LogLineView, logLineView } from "./task-logs.js";

/**
 * 按字节偏移分页读取日志文件（#18）。文件格式见 task-logs.ts：JSONL，每行一条日志，任意行首都是合法的分页位置。
 *
 * - 往后读（`after`）：从 `after` 所在的行首开始（不在行首时从下一行开始），读到凑够 `limit` 行匹配的日志为止。
 * - 往前读（`before`，默认文件末尾）：读 `before` 之前的完整行，取最后 `limit` 行匹配的日志。
 *
 * 只读完整的行（还在写入的最后半行不算），给了 `until` 时只读它之前的内容。每次最多扫描 `scanLimit` 字节
 * （默认 {@link SCAN_LIMIT}）的行，但至少读完一行：筛选条件很少匹配时，一页可能不足 `limit` 行，
 * 用 `start` / `end` 接着翻页即可。
 *
 * 按时刻定位（#347，{@link readLogPageAt}）：在文件里二分找到那一刻的位置，再从这个位置各往前、往后读半页。
 * 二分要求控制面时间随偏移不减：同一任务内记录时就保证了这一点（task-logs.ts；个别超过 2 秒的倒挂只会让找到的位置偏在倒挂附近）；
 * 升级之前写入的旧行没有控制面时间，是文件开头连续的一段，算在那一刻之前。
 */

export interface LogFilter {
	levels?: ReadonlySet<LogLineView["level"]>;
	sources?: ReadonlySet<LogLineView["source"]>;
}

interface PageLimits {
	limit: number;
	filter: LogFilter;
	/** 最多扫描多少字节的行，默认 {@link SCAN_LIMIT}。 */
	scanLimit?: number;
	/** 只读这个字节偏移之前的完整行（例如列出任务那一刻已写入的字节数），之后写入的不读。 */
	until?: number;
}

export type PageRequest =
	| ({ direction: "forward"; after: number } & PageLimits)
	| ({ direction: "backward"; before?: number } & PageLimits);

export interface PagedLine extends LogLineView {
	/** 这一行在文件中的字节偏移。 */
	offset: number;
}

export interface LogPage {
	lines: PagedLine[];
	/** 本页扫描范围 [start, end)：往前翻页用 `before=start`，往后翻页用 `after=end`。 */
	start: number;
	end: number;
	/** 读取时文件中完整行的总字节数（给了 `until` 时不超过它）。 */
	size: number;
}

/** 按时刻定位读到的一页：{@link LogPage} 加上那一刻的位置。字段含义见 @sfly/schema 的 LogLocate。 */
export interface LocatedPage extends LogPage {
	atOffset: number;
	exactSeq: number | null;
}

export interface LocateRequest {
	/** 要定位的时刻（控制面时间，毫秒）。 */
	at: number;
	limit: number;
	filter: LogFilter;
	scanLimit?: number;
}

/** 行的控制面时间与那一刻相差不超过这么多毫秒，就算正好对应。 */
const EXACT_WITHIN_MS = 1000;

const CHUNK = 64 * 1024;
/** 扫描上限很小时每次读取的最小字节数：只影响读文件的次数，不影响一页的结果。 */
const MIN_CHUNK = 4 * 1024;
export const SCAN_LIMIT = 8 * 1024 * 1024;

const matches = (line: LogLineView, filter: LogFilter) =>
	(!filter.levels || filter.levels.has(line.level)) &&
	(!filter.sources || filter.sources.has(line.source));

/** 打开的日志文件，和读它要用的量：完整行的总字节数、扫描上限、每次读取的字节数。 */
interface Reader {
	handle: FileHandle;
	size: number;
	scanLimit: number;
	chunk: number;
}

/** 打开日志文件读一次；文件不存在时是 `missing`。 */
async function withReader<T>(
	file: string,
	request: { scanLimit?: number; until?: number },
	missing: T,
	work: (reader: Reader) => Promise<T>,
): Promise<T> {
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
		throw error;
	}
	try {
		const scanLimit = request.scanLimit ?? SCAN_LIMIT;
		const chunk = Math.min(CHUNK, Math.max(MIN_CHUNK, scanLimit));
		const { size: fileSize } = await handle.stat();
		const size = await completeSize(handle, Math.min(fileSize, request.until ?? fileSize), chunk);
		return await work({ handle, size, scanLimit, chunk });
	} finally {
		await handle.close();
	}
}

/** 读一页日志；文件不存在时是空页。 */
export function readLogPage(file: string, request: PageRequest): Promise<LogPage> {
	return withReader(file, request, { lines: [], start: 0, end: 0, size: 0 }, (reader) =>
		request.direction === "forward" ? forward(reader, request) : backward(reader, request),
	);
}

/**
 * 读包含那一刻（`at`）的一页：前后各取一半，一侧不够时（靠近开头或末尾）由另一侧补满，所以那一刻早于第一行时是第一页，
 * 晚于最后一行时是最后一页。`start` / `end` 与 {@link readLogPage} 的意思相同，往前、往后接着翻页照旧。
 * 文件不存在时是空页，那一刻的位置是 0。
 */
export function readLogPageAt(file: string, request: LocateRequest): Promise<LocatedPage> {
	const missing = { lines: [], start: 0, end: 0, size: 0, atOffset: 0, exactSeq: null };
	return withReader(file, request, missing, async (reader) => {
		const { limit, filter } = request;
		const atOffset = await momentOffset(reader, request.at);
		const readSide = (direction: "backward" | "forward", count: number) =>
			direction === "forward"
				? forward(reader, { direction, after: atOffset, limit: count, filter })
				: backward(reader, { direction, before: atOffset, limit: count, filter });
		let older = await readSide("backward", Math.floor(limit / 2));
		const newer = await readSide("forward", limit - older.lines.length);
		const short = limit - older.lines.length - newer.lines.length;
		if (short > 0 && newer.end >= reader.size && older.start > 0) {
			older = await readSide("backward", limit - newer.lines.length);
		}
		const lines = [...older.lines, ...newer.lines];
		return {
			lines,
			start: older.start,
			end: newer.end,
			size: reader.size,
			atOffset,
			exactSeq: exactLine(lines, request.at),
		};
	});
}

/** 一行日志是不是不早于那一刻：旧行没有控制面时间，一律算早于。 */
const notBefore = (line: LogLineView, at: number) =>
	line.time !== null && Date.parse(line.time) >= at;

/**
 * 那一刻在文件里的位置：第一个不早于 `at` 的行的行首，都早于它时是文件末尾。
 * 在字节范围上二分：lo、hi 始终是行首（或末尾），lo 之前的行都早于 at，hi 起的行都不早于 at。
 */
async function momentOffset(reader: Reader, at: number): Promise<number> {
	const { handle, size, chunk } = reader;
	let lo = 0;
	let hi = size;
	while (lo < hi) {
		const start = await lineStart(handle, Math.floor((lo + hi) / 2), chunk);
		const { row, next } = await lineFrom(reader, start);
		if (notBefore(parse(row), at)) hi = start;
		else lo = next;
	}
	return lo;
}

/** 行首 `start` 开始的一行（不含换行符）和下一行的行首；`start` 必须在完整行的范围里。 */
async function lineFrom(
	{ handle, size, chunk }: Reader,
	start: number,
): Promise<{ row: Buffer; next: number }> {
	let pending: Buffer = Buffer.alloc(0);
	for (let pos = start; pos < size; ) {
		const bytes = await read(handle, pos, Math.min(chunk, size - pos));
		pos += bytes.length;
		pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		const nl = pending.indexOf(0x0a);
		if (nl >= 0) return { row: pending.subarray(0, nl), next: start + nl + 1 };
		if (bytes.length === 0) break;
	}
	throw new Error(`日志文件的 ${start} 处不是完整的行`);
}

/** 页里正好对应那一刻的行的序号：控制面时间离 `at` 最近、相差不超过 {@link EXACT_WITHIN_MS}，一样近时取前一行。 */
function exactLine(lines: readonly PagedLine[], at: number): number | null {
	let best: PagedLine | undefined;
	let bestGap = EXACT_WITHIN_MS + 1;
	for (const line of lines) {
		if (line.time === null) continue;
		const gap = Math.abs(Date.parse(line.time) - at);
		if (gap < bestGap) {
			best = line;
			bestGap = gap;
		}
	}
	return best?.seq ?? null;
}

async function read(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

/** 文件中完整行的总字节数（去掉末尾还没写完的半行）。 */
async function completeSize(handle: FileHandle, size: number, chunk: number): Promise<number> {
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - chunk);
		const bytes = await read(handle, start, end - start);
		const nl = bytes.lastIndexOf(0x0a);
		if (nl >= 0) return start + nl + 1;
		end = start;
	}
	return 0;
}

/** 解析文件里的一行；升级之前写入的行按「只有 Agent 时间」读出（task-logs.ts 的 logLineView）。 */
const parse = (bytes: Buffer): LogLineView => logLineView(JSON.parse(bytes.toString("utf8")));

async function forward(
	{ handle, size, scanLimit, chunk }: Reader,
	request: Extract<PageRequest, { direction: "forward" }>,
): Promise<LogPage> {
	let pos = Math.min(Math.max(0, request.after), size);
	// 不在行首：跳到下一行行首。
	if (pos > 0 && (await read(handle, pos - 1, 1))[0] !== 0x0a) {
		while (pos < size) {
			const bytes = await read(handle, pos, Math.min(chunk, size - pos));
			const nl = bytes.indexOf(0x0a);
			if (nl >= 0) {
				pos += nl + 1;
				break;
			}
			pos += bytes.length;
		}
	}
	const start = pos;
	const lines: PagedLine[] = [];
	let pending: Buffer = Buffer.alloc(0);
	let pendingAt = pos;
	// 扫描量按已经切分出的完整行算，一行比上限还长时也读完它，保证每次都有进展。
	const full = () => lines.length >= request.limit || pendingAt - start >= scanLimit;
	while (pos < size && !full()) {
		const bytes = await read(handle, pos, Math.min(chunk, size - pos));
		pos += bytes.length;
		pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		for (;;) {
			const nl = pending.indexOf(0x0a);
			if (nl < 0) break;
			const line = parse(pending.subarray(0, nl));
			if (matches(line, request.filter)) lines.push({ offset: pendingAt, ...line });
			pendingAt += nl + 1;
			pending = pending.subarray(nl + 1);
			if (full()) break;
		}
	}
	return { lines, start, end: pendingAt, size };
}

async function backward(
	{ handle, size, scanLimit, chunk }: Reader,
	request: Extract<PageRequest, { direction: "backward" }>,
): Promise<LogPage> {
	let end = Math.min(Math.max(0, request.before ?? size), size);
	// 不在行首：只取这一行之前的完整行。
	if (end > 0 && end < size && (await read(handle, end - 1, 1))[0] !== 0x0a) {
		end = await lineStart(handle, end, chunk);
	}
	const found: PagedLine[] = [];
	let pos = end;
	// pending 是 [pendingAt, pos 之后已读部分) 中还没切分的字节：它的开头可能是半行。
	let pending: Buffer = Buffer.alloc(0);
	let start = end;
	const full = () => found.length >= request.limit || end - start >= scanLimit;
	while (start > 0 && !full()) {
		const from = Math.max(0, pos - chunk);
		const bytes = await read(handle, from, pos - from);
		pos = from;
		pending = pending.length ? Buffer.concat([bytes, pending]) : bytes;
		// 从后往前切出完整的行：pending 末尾是行尾（或 end），开头在 pos > 0 时可能是半行。
		let lineEnd = pending.length;
		for (;;) {
			const nl = lineEnd >= 2 ? pending.lastIndexOf(0x0a, lineEnd - 2) : -1;
			if (nl < 0 && pos > 0) break;
			const lineFrom = nl + 1;
			const line = parse(pending.subarray(lineFrom, lineEnd - 1));
			start = pos + lineFrom;
			if (matches(line, request.filter)) found.push({ offset: start, ...line });
			lineEnd = lineFrom;
			if (lineEnd === 0 || full()) break;
		}
		pending = pending.subarray(0, lineEnd);
	}
	return { lines: found.reverse(), start, end, size };
}

/** `pos` 所在行的行首偏移。 */
async function lineStart(handle: FileHandle, pos: number, chunk: number): Promise<number> {
	let end = pos;
	while (end > 0) {
		const from = Math.max(0, end - chunk);
		const bytes = await read(handle, from, end - from);
		const nl = bytes.lastIndexOf(0x0a);
		if (nl >= 0) return from + nl + 1;
		end = from;
	}
	return 0;
}
