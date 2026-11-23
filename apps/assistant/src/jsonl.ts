/**
 * pi 的标准输出按 JSONL 切行（pi `docs/rpc.md`「Framing」）：只按 LF 切，去掉行尾的 CR；JSON 字符串里的
 * U+2028、U+2029 不是换行（Node 的 `readline` 会把它们当换行，所以不用它）。按字节切，一行跨两次读到也拼得对，
 * 多字节字符被两次读到拆开也不会坏。
 */
export class LineSplitter {
	#pending: Buffer = Buffer.alloc(0);

	/** 放进一段读到的字节，返回其中完整的行（不含 LF，去掉行尾的 CR）。 */
	push(chunk: Buffer): string[] {
		const data = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
		const lines: string[] = [];
		let start = 0;
		for (let lf = data.indexOf(0x0a, start); lf !== -1; lf = data.indexOf(0x0a, start)) {
			const end = lf > start && data[lf - 1] === 0x0d ? lf - 1 : lf;
			lines.push(data.toString("utf8", start, end));
			start = lf + 1;
		}
		this.#pending = Buffer.from(data.subarray(start));
		return lines;
	}

	/** 流结束时没有以 LF 结尾的最后一行（没有就是 undefined）。 */
	end(): string | undefined {
		if (this.#pending.length === 0) return undefined;
		let tail = this.#pending;
		if (tail[tail.length - 1] === 0x0d) tail = tail.subarray(0, -1);
		this.#pending = Buffer.alloc(0);
		return tail.toString("utf8");
	}
}
