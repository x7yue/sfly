// 打码的参照实现：这一版之前的做法（#479 起的正则的多选一，加长文本的字面量查找），去掉了预算和工作量的上限。
// 现在的 `SecretSet.mask` 用自动机（src/logs/aho-corasick.ts），输出必须和它逐字相同：随机对照用它。
// 输出的定义：所有文本的所有完整的出现，重叠的（后一个的开头在前一个的结尾之前）合成一段，每段换一个掩码，
// 相邻但不重叠的各是一段。

const MAX_REGEX_TEXT_CHARS = 1024;
const MAX_REGEX_SOURCE_CHARS = 8192;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

function compareLongestFirst(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return x - y;
	}
	return b.length - a.length;
}

function chunksOf(texts: readonly string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const text of texts) {
		const escaped = escapeRegExp(text).length + 1;
		if (current.length > 0 && size + escaped > MAX_REGEX_SOURCE_CHARS) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(text);
		size += escaped;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** 有没有两个文本（可以是同一个）会部分重叠：一个的真后缀等于另一个的真前缀（逐对比，参照实现不求快）。 */
function mayPartiallyOverlap(texts: readonly string[]): boolean {
	for (const x of texts) {
		for (const y of texts) {
			for (let from = 1; from < x.length; from++) {
				const suffix = x.slice(from);
				if (suffix.length < y.length && y.startsWith(suffix)) return true;
			}
		}
	}
	return false;
}

export function regexMask(texts: readonly string[], text: string, mask: string): string {
	const inline = texts.filter((t) => t.length <= MAX_REGEX_TEXT_CHARS).sort(compareLongestFirst);
	const literals = texts.filter((t) => t.length > MAX_REGEX_TEXT_CHARS);
	const regexes = chunksOf(inline).map(
		(chunk) => new RegExp(chunk.map(escapeRegExp).join("|"), "g"),
	);
	// 一个正则、没有字面量、不会部分重叠：一次 replace（长的在前，最靠前的出现上总取最长的）
	if (regexes.length === 1 && literals.length === 0 && !mayPartiallyOverlap(texts)) {
		return text.replace(regexes[0] as RegExp, mask);
	}
	const spans: Array<[number, number]> = [];
	for (const regex of regexes) {
		regex.lastIndex = 0;
		for (let m = regex.exec(text); m; m = regex.exec(text)) {
			if (m[0].length === 0) regex.lastIndex += 1;
			else {
				spans.push([m.index, m.index + m[0].length]);
				regex.lastIndex = m.index + 1;
			}
		}
	}
	for (const literal of literals) {
		for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
			spans.push([at, at + literal.length]);
		}
	}
	if (spans.length === 0) return text;
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let out = "";
	let cursor = 0;
	let [from, to] = spans[0] as [number, number];
	for (const [start, end] of spans.slice(1)) {
		if (start < to) {
			to = Math.max(to, end);
			continue;
		}
		out += text.slice(cursor, from) + mask;
		cursor = to;
		[from, to] = [start, end];
	}
	out += text.slice(cursor, from) + mask;
	return out + text.slice(to);
}
