import { type FileHandle, open } from "node:fs/promises";
import type { LogLineView } from "./task-logs.js";

/**
 * 按字节偏移分页读取日志文件（#18）。文件格式见 task-logs.ts：JSONL，每行一条日志，任意行首都是合法的分页位置。
 *
 * - 往后读（`after`）：从 `after` 所在的行首开始（不在行首时从下一行开始），读到凑够 `limit` 行匹配的日志为止。
 * - 往前读（`before`，默认文件末尾）：读 `before` 之前的完整行，取最后 `limit` 行匹配的日志。
 *
 * 只读完整的行（还在写入的最后半行不算）。每次最多扫描 {@link SCAN_LIMIT} 字节：筛选条件很少匹配时，
 * 一页可能不足 `limit` 行，用 `start` / `end` 接着翻页即可。
 */

export interface LogFilter {
	levels?: ReadonlySet<LogLineView["level"]>;
	sources?: ReadonlySet<LogLineView["source"]>;
}

export type PageRequest =
	| { direction: "forward"; after: number; limit: number; filter: LogFilter }
	| { direction: "backward"; before?: number; limit: number; filter: LogFilter };

export interface PagedLine extends LogLineView {
	/** 这一行在文件中的字节偏移。 */
	offset: number;
}

export interface LogPage {
	lines: PagedLine[];
	/** 本页扫描范围 [start, end)：往前翻页用 `before=start`，往后翻页用 `after=end`。 */
	start: number;
	end: number;
	/** 读取时文件中完整行的总字节数。 */
	size: number;
}

const CHUNK = 64 * 1024;
const SCAN_LIMIT = 8 * 1024 * 1024;

const matches = (line: LogLineView, filter: LogFilter) =>
	(!filter.levels || filter.levels.has(line.level)) &&
	(!filter.sources || filter.sources.has(line.source));

/** 读一页日志；文件不存在时是空页。 */
export async function readLogPage(file: string, request: PageRequest): Promise<LogPage> {
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { lines: [], start: 0, end: 0, size: 0 };
		throw error;
	}
	try {
		const size = await completeSize(handle, (await handle.stat()).size);
		return request.direction === "forward"
			? await forward(handle, size, request)
			: await backward(handle, size, request);
	} finally {
		await handle.close();
	}
}

async function read(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

/** 文件中完整行的总字节数（去掉末尾还没写完的半行）。 */
async function completeSize(handle: FileHandle, size: number): Promise<number> {
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - CHUNK);
		const bytes = await read(handle, start, end - start);
		const nl = bytes.lastIndexOf(0x0a);
		if (nl >= 0) return start + nl + 1;
		end = start;
	}
	return 0;
}

const parse = (bytes: Buffer): LogLineView => JSON.parse(bytes.toString("utf8")) as LogLineView;

async function forward(
	handle: FileHandle,
	size: number,
	request: Extract<PageRequest, { direction: "forward" }>,
): Promise<LogPage> {
	let pos = Math.min(Math.max(0, request.after), size);
	// 不在行首：跳到下一行行首。
	if (pos > 0 && (await read(handle, pos - 1, 1))[0] !== 0x0a) {
		while (pos < size) {
			const bytes = await read(handle, pos, Math.min(CHUNK, size - pos));
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
	while (pos < size && lines.length < request.limit && pos - start < SCAN_LIMIT) {
		const bytes = await read(handle, pos, Math.min(CHUNK, size - pos));
		pos += bytes.length;
		pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		let from = 0;
		for (;;) {
			const nl = pending.indexOf(0x0a, from);
			if (nl < 0) break;
			const line = parse(pending.subarray(from, nl));
			if (matches(line, request.filter)) lines.push({ offset: pendingAt + from, ...line });
			from = nl + 1;
			if (lines.length >= request.limit) break;
		}
		pendingAt += from;
		pending = pending.subarray(from);
		if (lines.length >= request.limit) break;
	}
	return { lines, start, end: pendingAt, size };
}

async function backward(
	handle: FileHandle,
	size: number,
	request: Extract<PageRequest, { direction: "backward" }>,
): Promise<LogPage> {
	let end = Math.min(Math.max(0, request.before ?? size), size);
	// 不在行首：只取这一行之前的完整行。
	if (end > 0 && end < size && (await read(handle, end - 1, 1))[0] !== 0x0a) {
		end = await lineStart(handle, end);
	}
	const found: PagedLine[] = [];
	let pos = end;
	// pending 是 [pendingAt, pos 之后已读部分) 中还没切分的字节：它的开头可能是半行。
	let pending: Buffer = Buffer.alloc(0);
	let start = end;
	while (start > 0 && found.length < request.limit && end - start < SCAN_LIMIT) {
		const from = Math.max(0, pos - CHUNK);
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
			if (lineEnd === 0 || found.length >= request.limit) break;
		}
		pending = pending.subarray(0, lineEnd);
	}
	return { lines: found.reverse(), start, end, size };
}

/** `pos` 所在行的行首偏移。 */
async function lineStart(handle: FileHandle, pos: number): Promise<number> {
	let end = pos;
	while (end > 0) {
		const from = Math.max(0, end - CHUNK);
		const bytes = await read(handle, from, end - from);
		const nl = bytes.lastIndexOf(0x0a);
		if (nl >= 0) return from + nl + 1;
		end = from;
	}
	return 0;
}
