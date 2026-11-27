import { codePointLabel, REJECTED_NAME_CHARACTER, scanCharacters } from "@sfly/schema";

/**
 * 显示「别人写的、平台不保证内容」的文字（Agent 报的名称和版本、节点写的说明和输出、失败原因、日志、产物的名称、节点包的元信息……）
 * 之前先过这里（#699）。页面按文字渲染，终端的转义序列不起作用，但**改变文字方向的控制字符和看不见的字符照样有效**：
 * 一个名字可以倒着显示，旁边的文字也被带着乱序，或者藏着看不见的内容。
 *
 * 做两件事：① 看不见的字符和控制字符写成看得见的样子（`U+202E` 加一句说明）；② 文字的方向隔离在自己的范围里（`UntrustedText`
 * 组件的 `<bdi dir="ltr">`：**基准方向一律是从左到右**，和整个控制台一样；从右到左书写的文字自己成一段，不影响旁边的文字，
 * 也不会因为它在开头就把整行翻过来）。**字符表和位置规则都是 `@sfly/schema` 的 `text-safety.ts` 里那一份**（{@link REJECTED_NAME_CHARACTER}、
 * {@link scanCharacters}；令牌名称、显示名的校验用的也是它，命令行把同一张表写成 `\uXXXX`，控制台写成一小块），这里不另写：
 * 零宽连接符、零宽不连字符、变体选择符三种例外紧跟在一个看得见的字符后面才原样显示（波斯文、带零宽连接符的组合表情、表情的呈现方式），
 * 位置不对的和别的一样写出来。
 *
 * 正常的文字原样显示：中文、表情、从右到左书写的文字。**没有要写出来的字符、也没有从右到左书写的字母的文字不包一层**（{@link isPlainText}）：
 * 它既没有要写出来的东西，也影响不了旁边文字的方向，直接是文字节点，页面上的节点数和原来一样。
 */

/** `line`：单行的名字这一类，所有控制字符都写出来；`text`：可以多行的正文（失败原因、日志、输出），换行和制表符是排版，照常显示。 */
export type UntrustedMode = "line" | "text";

/** 一段文字：原样显示的，或者一个被写出来的字符。 */
export type UntrustedSegment =
	| { kind: "text"; text: string }
	| {
			kind: "hidden";
			codePoint: number;
			/** 写出来的样子：`U+202E`。 */
			label: string;
			/** 一句话说明它是什么（悬停提示和读屏用）。 */
			name: string;
	  };

const ZERO_WIDTH_JOINER = 0x200d;
const ZERO_WIDTH_NON_JOINER = 0x200c;

/** 表里的字符，加上三种例外（它们要看位置）。 */
const SPECIAL = `(?:${REJECTED_NAME_CHARACTER.source})|[\\u200C\\u200D\\uFE00-\\uFE0F]`;
/** 文字里有没有要处理的字符：没有的（几乎所有的文字）直接原样返回，日志这种量大的地方每行只多这一次匹配。 */
const NEEDS_CHECK = {
	line: new RegExp(SPECIAL, "u"),
	text: new RegExp(`(?![\\t\\n])${SPECIAL}`, "u"),
};

/** 一个被写出来的字符是什么（说明里写的，不是拒绝表：表是 `@sfly/schema` 的）。 */
export function hiddenName(codePoint: number, misplaced = false): string {
	const label = codePointLabel(codePoint);
	if (misplaced) {
		const what =
			codePoint === ZERO_WIDTH_JOINER
				? "零宽连接符"
				: codePoint === ZERO_WIDTH_NON_JOINER
					? "零宽不连字符"
					: "变体选择符";
		return `${what}（${label}，位置不对：它只能紧跟在一个看得见的字符后面）`;
	}
	const what = (() => {
		if (codePoint === 0x0a) return "换行";
		if (codePoint === 0x09) return "制表符";
		if (codePoint === 0x0d) return "回车";
		if (codePoint === 0x1b) return "转义字符 ESC（终端控制序列的开头）";
		if (codePoint === 0x7f) return "删除字符 DEL";
		if (codePoint < 0x20 || (codePoint >= 0x80 && codePoint <= 0x9f)) return "控制字符";
		if (codePoint === 0x2028) return "行分隔符";
		if (codePoint === 0x2029) return "段分隔符";
		if (
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069) ||
			codePoint === 0x200e ||
			codePoint === 0x200f ||
			codePoint === 0x061c
		) {
			return "文字方向控制字符（会让文字倒着显示）";
		}
		if (codePoint === 0x200b) return "零宽空格";
		if (codePoint >= 0x2060 && codePoint <= 0x2064) return "词连接符或不可见的运算符";
		if (codePoint === 0xfeff) return "字节顺序标记（零宽不换行空格）";
		if (codePoint === 0x00ad) return "软连字符";
		if (codePoint === 0x2800) return "盲文空白";
		if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "标签字符";
		if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return "补充的变体选择符";
		if (codePoint >= 0x180b && codePoint <= 0x180f) return "蒙古文的变体选择符或分隔符";
		if (
			codePoint === 0x115f ||
			codePoint === 0x1160 ||
			codePoint === 0x3164 ||
			codePoint === 0xffa0
		) {
			return "填充字符";
		}
		if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "孤立的代理码元（不是合法的文字）";
		return "看不见的字符";
	})();
	return `${what}（${label}）`;
}

/** 把文字切成「原样显示」和「写出来」两种段；没有要处理的字符时就一段（原来的字符串，不复制）。判断是 schema 里的 {@link scanCharacters}。 */
export function untrustedSegments(text: string, mode: UntrustedMode = "line"): UntrustedSegment[] {
	if (!NEEDS_CHECK[mode].test(text)) return text === "" ? [] : [{ kind: "text", text }];
	const segments: UntrustedSegment[] = [];
	let shown = "";
	for (const scanned of scanCharacters(text, { layout: mode === "text" })) {
		if (scanned.verdict === "ok") {
			shown += scanned.character;
			continue;
		}
		if (shown !== "") segments.push({ kind: "text", text: shown });
		shown = "";
		segments.push({
			kind: "hidden",
			codePoint: scanned.codePoint,
			label: codePointLabel(scanned.codePoint),
			name: hiddenName(scanned.codePoint, scanned.verdict === "misplaced"),
		});
	}
	if (shown !== "") segments.push({ kind: "text", text: shown });
	return segments;
}

/** 有没有要写出来的字符。 */
export const hasHidden = (text: string, mode: UntrustedMode = "line"): boolean =>
	NEEDS_CHECK[mode].test(text) && untrustedSegments(text, mode).some((s) => s.kind === "hidden");

/**
 * 从右到左书写的字母：希伯来文、阿拉伯文、叙利亚文、塔纳文、恩科文、撒玛利亚文、曼达文，以及它们的补充和表现形式，
 * 加上 U+10800 起的古文字和 U+1E800 起的阿德拉姆文等。**宁可多不可少**：范围按块取（JS 的正则没有双向类别可查），
 * 多包一层只是多一个 `<bdi>`，漏了才会让这一类文字影响旁边的文字。
 */
const RIGHT_TO_LEFT_LETTER =
	/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * 文字能不能直接渲染成文字节点、不包 `<bdi>`：没有要写出来的字符（表里的字符、位置不对的例外字符）、也没有从右到左书写的字母。
 * 这样的文字既没有要写出来的东西，也影响不了旁边文字的方向（基准方向是控制台的从左到右）；几乎所有的文字（中文、英文、表情、
 * 带零宽连接符的组合表情）都是。一次正则匹配，有例外字符时再按位置规则看一遍。
 */
export function isPlainText(text: string, mode: UntrustedMode = "line"): boolean {
	if (RIGHT_TO_LEFT_LETTER.test(text)) return false;
	return !hasHidden(text, mode);
}

/**
 * 纯文字的写法：写出来的字符换成 `⟨U+202E⟩` 这样的一小段字，给没法放组件的地方用（`title`、`aria-label`、提示里的全文、
 * 按文字截断的 `Truncate`）。属性里的文字没有「隔离」的办法，所以先把控制字符换掉：换掉之后里面没有任何控制字符，不会带着旁边乱序。
 */
export function untrustedPlain(text: string, mode: UntrustedMode = "line"): string {
	const segments = untrustedSegments(text, mode);
	if (segments.length === 1 && segments[0]?.kind === "text") return text;
	return segments
		.map((segment) => (segment.kind === "text" ? segment.text : `⟨${segment.label}⟩`))
		.join("");
}
