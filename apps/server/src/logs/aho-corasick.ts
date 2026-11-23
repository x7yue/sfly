/**
 * 多模式匹配（Aho–Corasick）：把一批文本放进一个自动机，扫一遍文字就找出全部文本的全部完整的出现。
 * 打码（{@link SecretSet.mask}）用它，取代原来的「正则的多选一加长值的索引」：正则的多选一是回溯式的，每个字符的代价取决于
 * 值的形状（开头怎么分叉、有没有重复的结构），所以要给扫描定价，而价格怎么调都有反例；这里的代价和值的形状无关。
 *
 * - **步数是线性的**：每个字符前进一步，沿失败链退的步数合计不超过前进的步数（总数不超过 2n），与文本的个数、形状无关；
 *   前进和退回的每一步是 O(1) 的数组下标或哈希表的查找。
 * - **每一步的耗时有上限，靠总长有上限**：步数是构造保证的，每一步的耗时不是——自动机放不进缓存时，每一步可能是一次缓存外的
 *   内存访问（总长 2 M 个字符以上、最刁钻的形状下每个字符 32 到 160 纳秒（安静的机器到忙的机器），是随机的值集合的 3 到 15 倍以上）。所以所有文本的总长有上限
 *   （{@link MAX_AUTOMATON_CHARS}，1 M 个字符），自动机最多十几 MB，放得进缓存；同样的形状这时是 11 到 24 纳秒。
 *   这两个数是在安静的机器上、总长到上限、最刁钻的形状（沿失败链退一步就落到内存里另一处）下量的；机器负载高、别的进程占着
 *   缓存时同样的形状量到过 46 到 74 纳秒（慢 3 到 5 倍），自动机约 16 MiB，在二级缓存的边上。
 *   打码不是常数时间的：耗时随文字和值的关系变化（例如文字里的字符能不能作某个文本的开头，见根状态的跳过），
 *   规矩（docs/SEMANTICS.md §2.1）保证的是输出只取决于完整的出现。
 * - **找到什么**：每个位置只看以它结尾的最长的那个文本（更短的出现被它包含，合并之后是同一段），所以不沿输出链走，
 *   一个位置上有多少个文本以它结尾不影响代价。重叠的出现合成一段（相邻但不重叠的各是一段），边扫边合成，最后一共有多少段
 *   是「完整的出现」的次数，调用方据此设上限（{@link scanSpans} 的 `limit`）。
 * - **大小和所有文本的总长成正比**：每个节点约 11 字节，另有最浅的几层的完整转移表（最多 4 MB）和字符类表（256 KB）。
 *
 * 表示：节点按插入的顺序编号，**一个文本里新建的节点连续编号**，所以链上的孩子就是 `s + 1`，不用存；只有分叉出去的孩子
 * （每个文本最多一个）放哈希表。最浅的若干层（按广度优先，最多 {@link DENSE_ENTRIES} 项）另存完整的转移表，编号在前，
 * 随机的文字绝大多数时间停在这几层里，每个字符是一次表的查找；更深的节点走「链上的孩子、哈希表、失败链」。
 */

/**
 * 所有文本的总长（UTF-16 码元）超过这个数就不建自动机：节点数不超过它，约 11 字节一个节点，自动机最多十几 MB。
 * 这个数是每一步耗时的上限的来源（见文件头）：再大，自动机放不进缓存，最刁钻的形状下每个字符的耗时是现在的 6 到 8 倍。
 */
export const MAX_AUTOMATON_CHARS = 1 << 20;

/** 完整转移表最多这么多项（每项 4 字节）：每个字符类一项，一行一个节点。 */
const DENSE_ENTRIES = 1 << 20;

/** 一次扫描最多记这么多段（合并之后），超过时 {@link scanSpans} 放弃。 */
export const MAX_SPANS = 1 << 20;

export interface Automaton {
	/** 有完整转移表的节点数：编号小于它的节点（根是 0）的转移直接查表。 */
	readonly dense: number;
	/** 字符类的个数（含类 0：所有文本里都没有的字符，转移到根）。 */
	readonly width: number;
	/** 码元 → 字符类（0 表示所有文本里都没有这个码元）；65536 个码元都出现时有 65536 个类，所以不是 16 位。 */
	readonly classOf: Uint32Array;
	/** 每个字符类：能不能是某个文本的第一个字符（根状态下直接跳过不能开头的字符，只加快扫描，不改变结果）。 */
	readonly canStart: Uint8Array;
	/** 稠密节点的转移表：`delta[节点 * width + 字符类]`。 */
	readonly delta: Int32Array;
	/** 稀疏节点进来的码元（用于判断 s+1 是不是链上的孩子、校验哈希表的命中）。 */
	readonly ch: Uint16Array;
	/** 1：这个节点不是前一个节点的链上的孩子（是分叉出来的第一个节点）。最后一项是哨兵（总是 1）。 */
	readonly branch: Uint8Array;
	/** 稀疏节点的失败链。 */
	readonly fail: Int32Array;
	/** 以这个节点（包括沿失败链能到的）结尾的最长的文本的长度，没有为 0。 */
	readonly out: Int32Array;
	/** 分叉的孩子：（父节点，码元）→ 孩子，开放寻址；`hParent` 里 -1 表示空。 */
	readonly hParent: Int32Array;
	readonly hChild: Int32Array;
	readonly hMask: number;
	readonly seedA: number;
	readonly seedB: number;
}

const seed = (): number => (Math.floor(Math.random() * 0x3fffffff) << 1) | 1;

/** 哈希表里 `(parent, ch)` 的槽位：用每个自动机自己的随机种子，值的提供者造不出专门撞它的值。 */
function slotOf(parent: number, ch: number, seedA: number, seedB: number, mask: number): number {
	let h = Math.imul(parent ^ Math.imul(ch + 1, seedB), seedA);
	h ^= h >>> 15;
	return h & mask;
}

/**
 * 建自动机。`texts` 里的空串忽略；总长超过 `maxChars`（默认 {@link MAX_AUTOMATON_CHARS}）时返回 undefined（调用方把文字整段盖住）。
 * 建的时间和总长成正比，是同步的：总长到上限时 0.1 到 0.25 秒（同一份值集合只建一次，缓存放得下几份）。
 */
export function buildAutomaton(
	texts: readonly string[],
	maxChars: number = MAX_AUTOMATON_CHARS,
	denseEntries: number = DENSE_ENTRIES,
): Automaton | undefined {
	let total = 0;
	for (const text of texts) total += text.length;
	if (total > maxChars) return undefined;

	// ---- 1. 字典树，节点按插入的顺序编号（0 是根）；文本新建的节点连续编号 ----
	const chO = new Uint16Array(total + 2);
	const branchO = new Uint8Array(total + 2);
	const outO = new Int32Array(total + 2);
	const seedA = seed();
	const seedB = seed();
	let bits = 4;
	while (1 << bits < 2 * texts.length + 8) bits += 1;
	let hParent = new Int32Array(1 << bits).fill(-1);
	let hChild = new Int32Array(1 << bits);
	let hCount = 0;
	const bParents: number[] = [];
	const bNodes: number[] = [];
	let n = 1;

	const hashGet = (parent: number, ch: number): number => {
		const mask = hParent.length - 1;
		for (let h = slotOf(parent, ch, seedA, seedB, mask); ; h = (h + 1) & mask) {
			const p = hParent[h] as number;
			if (p < 0) return -1;
			if (p === parent && chO[hChild[h] as number] === ch) return hChild[h] as number;
		}
	};
	const hashPut = (parent: number, ch: number, child: number) => {
		if ((hCount + 1) * 2 > hParent.length) {
			const oldParent = hParent;
			const oldChild = hChild;
			hParent = new Int32Array(oldParent.length * 2).fill(-1);
			hChild = new Int32Array(oldParent.length * 2);
			const mask = hParent.length - 1;
			for (let i = 0; i < oldParent.length; i++) {
				const p = oldParent[i] as number;
				if (p < 0) continue;
				let h = slotOf(p, chO[oldChild[i] as number] as number, seedA, seedB, mask);
				while ((hParent[h] as number) >= 0) h = (h + 1) & mask;
				hParent[h] = p;
				hChild[h] = oldChild[i] as number;
			}
		}
		const mask = hParent.length - 1;
		let h = slotOf(parent, ch, seedA, seedB, mask);
		while ((hParent[h] as number) >= 0) h = (h + 1) & mask;
		hParent[h] = parent;
		hChild[h] = child;
		hCount += 1;
	};
	/** 孩子：链上的（`s + 1`，不是分叉出来的）或哈希表里的；没有 -1。 */
	const child = (s: number, ch: number): number => {
		const t = s + 1;
		if (t < n && branchO[t] === 0 && chO[t] === ch) return t;
		return hashGet(s, ch);
	};

	for (const text of texts) {
		if (text.length === 0) continue;
		let s = 0;
		let i = 0;
		for (; i < text.length; i++) {
			const t = child(s, text.charCodeAt(i));
			if (t < 0) break;
			s = t;
		}
		if (i < text.length) {
			const first = n;
			for (; i < text.length; i++) {
				chO[n] = text.charCodeAt(i);
				n += 1;
			}
			branchO[first] = 1;
			hashPut(s, chO[first] as number, first);
			bParents.push(s);
			bNodes.push(first);
			s = n - 1;
		}
		outO[s] = text.length;
	}
	branchO[n] = 1; // 哨兵

	// ---- 2. 字符类 ----
	const classOf = new Uint32Array(65536);
	let width = 1;
	for (const text of texts) {
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (classOf[c] === 0) {
				classOf[c] = width;
				width += 1;
			}
		}
	}

	// ---- 3. 广度优先：失败链、沿失败链最长的输出 ----
	// 分叉的孩子按父节点分组（CSR）。
	const starts = new Int32Array(n + 2);
	for (const p of bParents) starts[p + 1] = (starts[p + 1] as number) + 1;
	for (let i = 0; i <= n; i++) starts[i + 1] = (starts[i + 1] as number) + (starts[i] as number);
	const grouped = new Int32Array(bNodes.length);
	const filled = starts.slice();
	for (let k = 0; k < bNodes.length; k++) {
		const p = bParents[k] as number;
		grouped[filled[p] as number] = bNodes[k] as number;
		filled[p] = (filled[p] as number) + 1;
	}
	const eachChild = (u: number, visit: (v: number) => void) => {
		const t = u + 1;
		if (t < n && branchO[t] === 0) visit(t);
		for (let k = starts[u] as number; k < (starts[u + 1] as number); k++) {
			visit(grouped[k] as number);
		}
	};
	const failO = new Int32Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;
	eachChild(0, (v) => {
		queue[tail++] = v;
	});
	while (head < tail) {
		const u = queue[head++] as number;
		eachChild(u, (v) => {
			const c = chO[v] as number;
			let f = failO[u] as number;
			let g = 0;
			if (u !== 0) {
				for (;;) {
					const w = child(f, c);
					if (w >= 0) {
						g = w;
						break;
					}
					if (f === 0) break;
					f = failO[f] as number;
				}
			}
			failO[v] = g;
			if (outO[v] === 0) outO[v] = outO[g] as number;
			queue[tail++] = v;
		});
	}

	// ---- 4. 稠密区：广度优先的前 R 个节点（根在内），编号 0..R-1；其余节点的编号是原来的编号加 R ----
	const maxRows = Math.max(1, Math.floor(denseEntries / width));
	const dense = Math.min(n, maxRows);
	const newId = new Int32Array(n); // 原来的编号 → 新的编号
	for (let v = 0; v < n; v++) newId[v] = v + dense;
	newId[0] = 0;
	for (let i = 0; i < dense - 1; i++) newId[queue[i] as number] = i + 1;
	const size = dense + n + 1;
	const ch = new Uint16Array(size);
	// 没有用到的位置（稠密节点原来的编号留下的空位、哨兵）都标成「不是链上的孩子」，扫描时 `s + 1` 落在它们上面不会被当成孩子。
	const branch = new Uint8Array(size).fill(1);
	const fail = new Int32Array(size);
	const out = new Int32Array(size);
	for (let v = 0; v < n; v++) {
		const id = newId[v] as number;
		out[id] = outO[v] as number;
		if (id >= dense) {
			ch[id] = chO[v] as number;
			branch[id] = branchO[v] as number;
			fail[id] = newId[failO[v] as number] as number;
		}
	}
	// 转移表：行 = 失败状态的行 + 自己的孩子
	const delta = new Int32Array(dense * width);
	const order = [0];
	for (let i = 0; i < dense - 1; i++) order.push(queue[i] as number);
	order.forEach((v, row) => {
		if (row > 0) {
			const from = (newId[failO[v] as number] as number) * width;
			delta.copyWithin(row * width, from, from + width);
		}
		eachChild(v, (w) => {
			delta[row * width + (classOf[chO[w] as number] as number)] = newId[w] as number;
		});
	});
	// 哈希表：只放稀疏节点的、父节点也是稀疏的分叉的孩子（稠密节点的孩子在转移表里）
	let finalBits = 4;
	let entries = 0;
	for (let k = 0; k < bNodes.length; k++) {
		if ((newId[bParents[k] as number] as number) >= dense) entries += 1;
	}
	while (1 << finalBits < 2 * entries + 8) finalBits += 1;
	const finalParent = new Int32Array(1 << finalBits).fill(-1);
	const finalChild = new Int32Array(1 << finalBits);
	const finalMask = finalParent.length - 1;
	for (let k = 0; k < bNodes.length; k++) {
		const parent = newId[bParents[k] as number] as number;
		if (parent < dense) continue;
		const node = newId[bNodes[k] as number] as number;
		let h = slotOf(parent, ch[node] as number, seedA, seedB, finalMask);
		while ((finalParent[h] as number) >= 0) h = (h + 1) & finalMask;
		finalParent[h] = parent;
		finalChild[h] = node;
	}
	const canStart = new Uint8Array(width);
	eachChild(0, (v) => {
		canStart[classOf[chO[v] as number] as number] = 1;
	});
	return {
		dense,
		width,
		canStart,
		classOf,
		delta,
		ch,
		branch,
		fail,
		out,
		hParent: finalParent,
		hChild: finalChild,
		hMask: finalMask,
		seedA,
		seedB,
	};
}

/** 自动机占的内存（字节）：所有数组的大小之和。值集合的缓存按它限大小（{@link secretSetOf}）。 */
export function automatonBytes(a: Automaton): number {
	return (
		a.classOf.byteLength +
		a.canStart.byteLength +
		a.delta.byteLength +
		a.ch.byteLength +
		a.branch.byteLength +
		a.fail.byteLength +
		a.out.byteLength +
		a.hParent.byteLength +
		a.hChild.byteLength
	);
}

/** 找到的段（合并之后）的起止：`scanSpans` 返回的个数以内有效，下一次扫描会覆盖。同步使用，不会同时有两处在用。 */
let spanStarts = new Int32Array(1024);
let spanEnds = new Int32Array(1024);

function growSpans(): void {
	const starts = new Int32Array(spanStarts.length * 2);
	const ends = new Int32Array(spanEnds.length * 2);
	starts.set(spanStarts);
	ends.set(spanEnds);
	spanStarts = starts;
	spanEnds = ends;
}

/**
 * 扫一遍 `text`，把所有文本的完整的出现合并成段，起止在模块里的两个数组里（用 {@link maskedByAutomaton} 取）；返回段数，超过 `limit`
 * 时放弃，返回 -1。重叠的出现（后一个的开头在前一个的结尾之前）合成一段，相邻但不重叠的各是一段。
 * 走的步数是线性的（摊销，每个字符前进一步、退回的步数合计不超过前进的步数），每一步的耗时有上限（总长有上限，见文件头）。
 * 文字里有没有某个文本的开头、半截不影响输出和段数，只影响走的步数。
 */
export function scanSpans(a: Automaton, text: string, limit: number): number {
	const { dense, width, classOf, canStart, delta, ch, branch, fail, out, hParent, hChild, hMask } =
		a;
	const { seedA, seedB } = a;
	let s = 0;
	let top = 0;
	const length = text.length;
	for (let i = 0; i < length; i++) {
		let c = text.charCodeAt(i);
		let k = classOf[c] as number;
		if (s === 0) {
			// 根状态：跳过不能开头的字符（两次独立的查表，不在依赖链上）；只加快扫描，走到哪里的结果不变
			while (canStart[k] === 0) {
				i += 1;
				if (i >= length) return top;
				c = text.charCodeAt(i);
				k = classOf[c] as number;
			}
		}
		for (;;) {
			if (s < dense) {
				s = delta[s * width + k] as number;
				break;
			}
			const t = s + 1;
			if (branch[t] === 0 && ch[t] === c) {
				s = t;
				break;
			}
			let h = slotOf(s, c, seedA, seedB, hMask);
			let hit = -1;
			for (;;) {
				const p = hParent[h] as number;
				if (p < 0) break;
				if (p === s && ch[hChild[h] as number] === c) {
					hit = hChild[h] as number;
					break;
				}
				h = (h + 1) & hMask;
			}
			if (hit >= 0) {
				s = hit;
				break;
			}
			s = fail[s] as number;
		}
		const m = out[s] as number;
		if (m > 0) {
			// 以 i 结尾的最长的出现：[i + 1 - m, i + 1)。结尾是递增的，和栈顶（结尾在它开头之后的）重叠的并进来。
			let start = i + 1 - m;
			while (top > 0 && (spanEnds[top - 1] as number) > start) {
				top -= 1;
				if ((spanStarts[top] as number) < start) start = spanStarts[top] as number;
			}
			if (top >= limit) return -1;
			if (top >= spanStarts.length) growSpans();
			spanStarts[top] = start;
			spanEnds[top] = i + 1;
			top += 1;
		}
	}
	return top;
}

/**
 * 只输出 `text` 的 `[from, to)` 这一块（一段超长行加上前后的上下文之后，只显示中间那一段）：{@link scanSpans}（或 {@link mergeSpans}）
 * 刚找到的 `count` 段里，开头落在这一块里的整个换成一个 `mask`（超出 `to` 的部分不输出），开头在 `from` 之前的，落在这一块里的部分去掉
 * （前一段已经用一个掩码盖住了）。一个跨在拆分处的值因此只出现一个掩码，读的人拼起来看到的和不拆时一样。
 */
export function maskedRegion(
	text: string,
	count: number,
	from: number,
	to: number,
	mask: string,
): string {
	let out = "";
	let cursor = from;
	for (let k = 0; k < count; k++) {
		const start = spanStarts[k] as number;
		const end = spanEnds[k] as number;
		if (end <= from) continue;
		if (start >= to) break;
		if (start >= from) out += text.slice(cursor, start) + mask;
		cursor = Math.min(end, to);
	}
	return out + text.slice(cursor, to);
}

/** 把 {@link scanSpans} 刚找到的 `count` 段换成 `mask`（同步，紧接着扫描用）。 */
export function maskedByAutomaton(text: string, count: number, mask: string): string {
	let out = "";
	let cursor = 0;
	for (let k = 0; k < count; k++) {
		out += text.slice(cursor, spanStarts[k] as number) + mask;
		cursor = spanEnds[k] as number;
	}
	return out + text.slice(cursor);
}

/**
 * 扫一遍 `text` 走了多少步：前进（含查表）和沿失败链退回各算一步。只给测试用：线性是构造保证的（退回的步数不超过前进的步数，
 * 所以不超过 2 × 长度），测试在最坏的值集合上数出来，不看耗时。和 {@link scanSpans} 走的是同一条路。
 */
export function scanSteps(a: Automaton, text: string): { advances: number; fails: number } {
	const { dense, width, classOf, canStart, delta, ch, branch, fail, hParent, hChild, hMask } = a;
	let s = 0;
	let advances = 0;
	let fails = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		const k = classOf[c] as number;
		advances += 1;
		if (s === 0 && canStart[k] === 0) continue;
		for (;;) {
			if (s < dense) {
				s = delta[s * width + k] as number;
				break;
			}
			const t = s + 1;
			if (branch[t] === 0 && ch[t] === c) {
				s = t;
				break;
			}
			let h = slotOf(s, c, a.seedA, a.seedB, hMask);
			let hit = -1;
			for (;;) {
				const p = hParent[h] as number;
				if (p < 0) break;
				if (p === s && ch[hChild[h] as number] === c) {
					hit = hChild[h] as number;
					break;
				}
				h = (h + 1) & hMask;
			}
			if (hit >= 0) {
				s = hit;
				break;
			}
			fails += 1;
			s = fail[s] as number;
		}
	}
	return { advances, fails };
}
