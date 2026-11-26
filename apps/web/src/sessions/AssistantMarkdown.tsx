import {
	Children,
	Component,
	isValidElement,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { UntrustedText } from "#/components/untrusted-text";
import { INLINE_LINK } from "#/lib/inline-link";
import { untrustedPlain } from "#/lib/untrusted-text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { FollowContext } from "./timeline-follow";

/**
 * 助手的话（#550）：Markdown 渲染——段落、列表、代码块、行内代码、链接、引用、表格（GFM）、标题、脚注。
 *
 * **这是模型写的文字，不是控制台自己的文案**（docs/DESIGN-SYSTEM.md「不可信的文字」），所以和用户文档的 Markdown（`docs/Markdown.tsx`，
 * 内容是随仓库发布的）不是一回事：
 * - **每一个文字节点都经 `UntrustedText`**：方向控制字符、零宽字符、终端的转义字符写成看得见的占位，不会藏内容、也不会把旁边的文字带乱序。
 *   这条不靠每个组件各自记得包一层：{@link rehypeWrapText} 在解析之后、渲染之前把**所有**文字节点（含块级 HTML 变成的文字、根上和引用里的）
 *   换成一个 `span` 元素，`span` 组件统一交给 `UntrustedText`；只有代码块（`pre` 里面）的文字例外，它要拿原文，由 `pre` 自己经组件显示。
 *   `AssistantMarkdown.test.ts` 用一批写法逐个断言渲染结果里没有原样的有害字符；
 * - **不渲染原始 HTML**（不开 `rehype-raw`：模型写的 `<script>`、`<img>` 当作文字原样显示出来，不执行也不请求）；
 * - **不渲染图片**：图片地址由模型写，渲染就是让浏览器去请求它指定的地址（可以带着页面上看得到的东西出去），改成一行文字（图片的说明）；
 * - **链接只认 http(s) 的绝对地址**（react-markdown 自己还会把 `javascript:` 这类协议去掉）：新窗口打开，不带来源页（`noreferrer`），
 *   链接文字和地址对不上时（文字不是地址本身），后面写出地址的主机名，模型不能把「官方文档」指到别处而看不出来；别的链接（相对地址……）
 *   只显示文字，不可点；
 * - **嵌套太深的退回纯文字**：几 KB 的几千层嵌套引用会让 mdast 转 hast 的递归爆栈（`RangeError`），整个会话页换成路由默认的错误页，
 *   刷新也一样；再深一点（1800 层以上）渲染出来的 DOM 让浏览器的排版爆栈、**整个标签页崩溃**，错误边界兜不住（审查 #762）。三道：
 *   ① 先查每一行开头的层数（{@link tooDeeplyNested}，线性）和括号的嵌套深度（{@link tooManyOpenBrackets}，线性；连写的 `![` 解析是平方级），
 *   超过的不交给 Markdown——这是快速路径，**不是唯一的一道**：行首检查认不出以 `[` 开头的脚注定义里的深引用（`[^a]: >>>>…`）；
 *   ② **在解析出来的树上量深度**（{@link rehypeWrapText} 遍历时记，超过 {@link MAX_TREE_DEPTH} 抛 {@link MarkdownTooDeepError}），
 *   不论怎么写出来的，树深了就不去渲染，浏览器不会看到深的 DOM；③ 再包一个错误边界（{@link MarkdownBoundary}），② 抛的和别的原因让渲染
 *   抛的错都退回纯文字，只坏这一条，别的条目照常。失败过的这一条逐字出现时不每次都重试（每次重试是 0.1 到 0.4 秒的失败），整条消息到了再试一次。
 *   纯文字照样经 `UntrustedText`；
 * - **脚注**的标题和「回到正文」写中文（默认是英文的 `Footnotes`、`Back to reference 1`）。
 *
 * **逐字出现**时每来一段增量，这一条要整条重新解析一遍（react-markdown 不做增量解析；20 KB 约二十几毫秒，一帧 16.7 毫秒放不下）：
 * 所以逐字出现的那一条**最多每 {@link STREAM_PARSE_INTERVAL_MS} 毫秒解析一次**（节流，{@link useThrottledText}），中间来的增量先攒着；
 * 整条消息到了（`streaming` 为假）立刻解析最终的文字。20 KB 的一条，主线程每个增量忙的时间（`session-long-measure.spec.ts`）：不处理 9.4 毫秒，
 * 节流 2.4 毫秒；试过 `useDeferredValue`：解析是一次不可中断的整块，延迟只改变先后，每个增量还是解析一次，9.7 毫秒，没有改善。
 * 解析的结果按文字缓存（`useMemo`），文字没变的重新渲染不再解析。
 * 别的条目不受影响（`SessionTimeline` 的行是 `memo`）。
 */
export function AssistantMarkdown({
	text,
	streaming = false,
}: {
	text: string;
	streaming?: boolean;
}) {
	const shown = useThrottledText(text, streaming ? STREAM_PARSE_INTERVAL_MS : 0);
	const unsafe = useMemo(() => tooDeeplyNested(shown) || tooManyOpenBrackets(shown), [shown]);
	// 实际渲染出的文字变了（节流后延后的那一次）：内容变高了，在底部的人要跟到最新（时间线只在事件到达时按没节流的长度滚过一次）。
	const follow = useContext(FollowContext);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 渲染出的文字（`shown`）变了才需要跟一次
	useLayoutEffect(() => follow(), [shown, follow]);
	if (unsafe) return <PlainText text={shown} />;
	return (
		<MarkdownBoundary text={shown} streaming={streaming}>
			<Parsed text={shown} />
		</MarkdownBoundary>
	);
}

/** 逐字出现的助手的话最多隔多少毫秒重新解析一次。 */
export const STREAM_PARSE_INTERVAL_MS = 120;

/**
 * 节流：`intervalMs` 为 0 时就是 `text` 本身；大于 0 时最多每隔这么久才换成最新的 `text`（头一次变化之后等一个间隔，再取那时最新的；
 * 间隔里来的变化先攒着）。不是防抖：文字一直在变也每个间隔更新一次，不会饿死。
 */
export function useThrottledText(text: string, intervalMs: number): string {
	const [shown, setShown] = useState(text);
	const latest = useRef(text);
	latest.current = text;
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 文字变了才需要（在没有排着的时候）排一次更新，`text` 是触发它的依赖
	useEffect(() => {
		if (intervalMs === 0 || timer.current !== undefined) return;
		timer.current = setTimeout(() => {
			timer.current = undefined;
			setShown(latest.current);
		}, intervalMs);
	}, [text, intervalMs]);
	useEffect(() => () => clearTimeout(timer.current), []);
	return intervalMs === 0 ? text : shown;
}

/** 纯文字的显示（嵌套太深、渲染出错时）：保留换行，经 `UntrustedText`。 */
function PlainText({ text }: { text: string }) {
	return (
		<div data-fallback="plain" className="whitespace-pre-wrap">
			<UntrustedText text={text} mode="text" />
		</div>
	);
}

/** 解析并渲染：文字变了才重新解析（`useMemo`）。 */
function Parsed({ text }: { text: string }) {
	return useMemo(
		() => (
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeWrapText]}
				components={COMPONENTS}
				remarkRehypeOptions={FOOTNOTES}
			>
				{text}
			</ReactMarkdown>
		),
		[text],
	);
}

/** 脚注的标题和「回到正文」的说明：默认是英文，页面是中文的。 */
const FOOTNOTES = {
	footnoteLabel: "脚注",
	footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number) =>
		`回到正文第 ${referenceIndex + 1} 处${rereferenceIndex > 1 ? `（第 ${rereferenceIndex} 次引用）` : ""}`,
};

/** 解析出来的树比 {@link MAX_TREE_DEPTH} 还深（{@link rehypeWrapText} 抛的）：不去渲染它。 */
export class MarkdownTooDeepError extends Error {
	constructor() {
		super(`Markdown 的嵌套超过 ${MAX_TREE_DEPTH} 层`);
		this.name = "MarkdownTooDeepError";
	}
}

/**
 * 渲染这一条时抛了错（{@link MarkdownTooDeepError}，或者前两道没拦住的别的原因）：这一条退回纯文字，别的条目照常。React 的错误边界
 * 只有类组件能写。**重试**：失败过的这一条在逐字出现（`streaming`）时不再每变一次文字就重试——深到会抛的话每次都是 0.1 到 0.4 秒的失败，
 * 每 120 毫秒一次——记住失败；整条消息到了（`streaming` 变假）重试一次（错可能只是文字没写完），再失败就一直是失败，直到文字变了。
 */
export class MarkdownBoundary extends Component<
	{ text: string; streaming: boolean; children: ReactNode },
	{ text: string; streaming: boolean; failed: boolean }
> {
	state = { text: this.props.text, streaming: this.props.streaming, failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	static getDerivedStateFromProps(
		props: { text: string; streaming: boolean },
		state: { text: string; streaming: boolean; failed: boolean },
	) {
		if (props.text === state.text && props.streaming === state.streaming) return null;
		// 不在逐字出现、而且（刚刚整条到了，或者文字变了）：重试一次。逐字出现中：失败的保持失败。
		const retry = !props.streaming && (state.streaming || props.text !== state.text);
		return {
			text: props.text,
			streaming: props.streaming,
			failed: retry ? false : state.failed,
		};
	}

	render() {
		return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
	}
}

/**
 * 一行开头的嵌套层数：引用的 `>`、列表的标记（`-`、`*`、`+` 或「数字加 `.` / `)`」，后面要有空白）、每两个空格的缩进各算一层
 * （标记后面紧跟的那一个空格是分隔，不算缩进）；遇到别的字符就停。**只看每一行的开头，总共线性**。
 */
export function nestingLevels(line: string): number {
	let levels = 0;
	let spaces = 0;
	let i = 0;
	while (i < line.length) {
		const c = line[i] as string;
		if (c === " ") {
			spaces += 1;
			i += 1;
		} else if (c === "\t") {
			spaces += 4;
			i += 1;
		} else if (c === ">") {
			levels += 1;
			i += line[i + 1] === " " ? 2 : 1;
		} else if (c === "-" || c === "*" || c === "+") {
			const next = line[i + 1];
			if (next !== " " && next !== "\t") break;
			levels += 1;
			i += 2;
		} else if (c >= "0" && c <= "9") {
			let j = i;
			while (j < line.length && (line[j] as string) >= "0" && (line[j] as string) <= "9") j += 1;
			const marker = line[j];
			const after = line[j + 1];
			if ((marker !== "." && marker !== ")") || (after !== " " && after !== "\t") || j - i > 9)
				break;
			levels += 1;
			i = j + 2;
		} else {
			break;
		}
	}
	return levels + Math.floor(spaces / 2);
}

/** 嵌套多少层以上不交给 Markdown：正常的话最多十来层；爆栈要几千层（引用）、几百层（列表缩进）。 */
export const MAX_NESTING_LEVELS = 64;

/** 有没有哪一行开头的嵌套层数超过 {@link MAX_NESTING_LEVELS}。线性：每一行只看开头。 */
export function tooDeeplyNested(text: string): boolean {
	let start = 0;
	while (start <= text.length) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		if (nestingLevels(text.slice(start, end)) > MAX_NESTING_LEVELS) return true;
		start = end + 1;
	}
	return false;
}

/**
 * 括号的嵌套深度：`[` 加一、`]` 减一（不小于 0），取最大值。线性。嵌套着成对的 `![ … ](u)`（所有开括号在前、闭括号在后）解析是平方级——
 * 9 KB 约 0.5 秒、18 KB 约 1.8 秒、36 KB 约 7.7 秒，每次打开都冻住（审查 #762 第二轮）；没闭合的 `[`、平摊的 `[1,2]`、平摊的链接、
 * 代码块里的大数组都是线性的，所以量深度，不数个数（数个数会把一个大数组误伤成纯文字）。
 */
export function bracketDepth(text: string): number {
	let depth = 0;
	let max = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 91) {
			depth += 1;
			if (depth > max) max = depth;
		} else if (code === 93 && depth > 0) {
			depth -= 1;
		}
	}
	return max;
}

/** 括号嵌套多深以上不交给 Markdown：正常的话不超过十来层；这个深度的解析约二三十毫秒（平方级）。 */
export const MAX_BRACKET_DEPTH = 256;

/** 括号嵌套太深（连写的 `![`）：解析会冻住页面，按纯文字显示。 */
export const tooManyOpenBrackets = (text: string): boolean =>
	bracketDepth(text) > MAX_BRACKET_DEPTH;

/** hast 树里的一个节点（只写这里用到的几项：不依赖 `@types/hast`）。 */
interface HastNode {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

/** 只有空格、制表符、换行的文字：表格和列表的元素之间的换行，react-markdown 自己会处理，不换成元素。 */
const ONLY_WHITESPACE = /^[ \t\n\r]*$/;

/**
 * 解析出来的树最深允许多少层（根是第 0 层）：正常的话列表嵌三五层、引用两三层，十来层；复审 #762 量到的几千层、一千多层会让浏览器崩。
 * 一层 `ul` 加一层 `li` 算两层，所以 64 层够嵌三十层的列表。
 */
export const MAX_TREE_DEPTH = 64;

/**
 * rehype 插件：把树里**所有**文字节点——包括 `raw`（react-markdown 不开 `rehype-raw` 时会把块级和行内的 HTML 当文字显示）——换成
 * `span` 元素，里面是那段文字；`span` 组件统一把它交给 `UntrustedText`。代码块（`pre` 里面）的文字不动，由 `pre` 自己显示。
 * 只有空白的文字不动。不递归（用栈）：树很深也不会爆栈。
 *
 * **同一趟遍历里量树的深度**：超过 {@link MAX_TREE_DEPTH} 抛 {@link MarkdownTooDeepError}（`AssistantMarkdown` 的错误边界接住，退回纯文字），
 * 不论这么深的树是怎么写出来的（行首的引用、脚注定义里的引用、别的什么），深的 DOM 一个都到不了浏览器。
 */
export function rehypeWrapText() {
	return (tree: HastNode) => {
		const stack: [node: HastNode, inPre: boolean, depth: number][] = [[tree, false, 0]];
		for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
			const [node, inPre, depth] = top;
			const children = node.children;
			if (!children) continue;
			const insidePre = inPre || (node.type === "element" && node.tagName === "pre");
			for (let i = 0; i < children.length; i += 1) {
				const child = children[i] as HastNode;
				if (child.type === "text" || child.type === "raw") {
					const value = child.value ?? "";
					if (insidePre || ONLY_WHITESPACE.test(value)) continue;
					children[i] = {
						type: "element",
						tagName: "span",
						properties: {},
						children: [{ type: "text", value }],
					};
				} else if (child.children) {
					if (depth + 1 > MAX_TREE_DEPTH) throw new MarkdownTooDeepError();
					stack.push([child, insidePre, depth + 1]);
				}
			}
		}
	};
}

/** 链接的主机名；不是 http(s) 的绝对地址时为 null。 */
export function linkHost(href: string | undefined): string | null {
	if (href === undefined) return null;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
	} catch {
		return null;
	}
}

/** `<pre><code>…</code></pre>` 里的代码文字和语言（react-markdown 把语言写在 `<code>` 的 className 上）。 */
function codeOf(children: ReactNode): { text: string; language: string | undefined } {
	const code = Children.toArray(children)[0];
	if (!isValidElement<{ className?: string; children?: ReactNode }>(code)) {
		return { text: String(children ?? ""), language: undefined };
	}
	const raw = code.props.children;
	return {
		text: (typeof raw === "string" ? raw : String(raw ?? "")).replace(/\n$/, ""),
		language: /\blanguage-(\S+)/.exec(code.props.className ?? "")?.[1],
	};
}

/** hast 节点里的文字（链接文字和地址比较用；子节点已经被换成了 `span`，所以要看树，不能看渲染出来的 React 元素）。 */
function textOf(node: { value?: unknown; children?: readonly unknown[] } | undefined): string {
	if (node === undefined) return "";
	if (typeof node.value === "string") return node.value;
	return (node.children ?? [])
		.map((child) => textOf(child as { value?: unknown; children?: readonly unknown[] }))
		.join("");
}

const COMPONENTS: Components = {
	// 树里的文字都是 `rehypeWrapText` 换成的 `span`：在这里交给不可信文字组件。
	span: ({ children }) =>
		typeof children === "string" ? <UntrustedText text={children} mode="text" /> : children,
	h1: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
	h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
	h3: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
	h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
	h5: ({ children }) => <h5 className="mt-2 mb-1 text-sm font-semibold">{children}</h5>,
	h6: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-semibold">{children}</h6>,
	p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
	ul: ({ children }) => (
		<ul className="my-2 list-disc space-y-1 pl-5 marker:text-fg-3 first:mt-0 last:mb-0 [&_ol]:my-1 [&_ul]:my-1">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="my-2 list-decimal space-y-1 pl-5 marker:text-fg-3 first:mt-0 last:mb-0 [&_ol]:my-1 [&_ul]:my-1">
			{children}
		</ol>
	),
	li: ({ children }) => <li>{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="my-2 border-l-2 border-border-strong pl-3 text-fg-2 [&>p]:my-1">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-3 border-0 border-t border-border-soft" />,
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em>{children}</em>,
	del: ({ children }) => <del>{children}</del>,
	a: ({ href, children, node }) => {
		const host = linkHost(href);
		// 只认 http(s) 的绝对地址：别的只显示文字。
		if (host === null) return <>{children}</>;
		const label = textOf(node);
		// 链接文字就是地址本身（自动识别出来的链接）时不重复写；否则写出主机名：文字和地址对不上也看得出。
		const same = label === href || label === host;
		return (
			<a
				href={href}
				target="_blank"
				rel="noreferrer noopener nofollow"
				title={untrustedPlain(href ?? "")}
				className={INLINE_LINK}
			>
				{children}
				{!same && (
					<span className="text-fg-3">
						{" ("}
						<UntrustedText text={host} />)
					</span>
				)}
			</a>
		);
	},
	// 图片不渲染（见文件开头）：写出它的说明。
	img: ({ alt }) => (
		<span className="text-fg-3">
			[图片{alt ? "：" : ""}
			{alt ? <UntrustedText text={alt} /> : null}]
		</span>
	),
	// 行内代码；代码块的 `<code>` 由 `pre` 自己处理（它不经过这里）。
	code: ({ children }) => (
		<code className="rounded-sm bg-raised px-1 py-px font-mono text-xs text-fg-1">{children}</code>
	),
	pre: ({ children }) => {
		const { text, language } = codeOf(children);
		return (
			<pre
				data-testid="assistant-code"
				data-language={language}
				className="my-2 max-h-96 overflow-auto rounded-lg border border-border-soft bg-sunk px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-fg-2"
			>
				<UntrustedText text={text} mode="text" />
			</pre>
		);
	},
	table: ({ children }) => (
		<div className="my-2 overflow-hidden rounded-lg border border-border-soft">
			<Table scroll="x">{children}</Table>
		</div>
	),
	thead: ({ children }) => <TableHeader>{children}</TableHeader>,
	tbody: ({ children }) => <TableBody>{children}</TableBody>,
	tr: ({ children }) => <TableRow>{children}</TableRow>,
	th: ({ children }) => <TableHead>{children}</TableHead>,
	td: ({ children }) => <TableCell>{children}</TableCell>,
};
