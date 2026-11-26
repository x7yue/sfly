import { Children, isValidElement, type ReactNode } from "react";
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

/**
 * 助手的话（#550）：Markdown 渲染——段落、列表、代码块、行内代码、链接、引用、表格（GFM）、标题。
 *
 * **这是模型写的文字，不是控制台自己的文案**（docs/DESIGN-SYSTEM.md「不可信的文字」），所以和用户文档的 Markdown（`docs/Markdown.tsx`，
 * 内容是随仓库发布的）不是一回事：
 * - **每一个文字节点都经 `UntrustedText`**：方向控制字符、零宽字符、终端的转义字符写成看得见的占位，不会藏内容、也不会把旁边的文字带乱序；
 * - **不渲染原始 HTML**（不开 `rehype-raw`：模型写的 `<script>`、`<img>` 当作文字原样显示出来，不执行也不请求）；
 * - **不渲染图片**：图片地址由模型写，渲染就是让浏览器去请求它指定的地址（可以带着页面上看得到的东西出去），改成一行文字（图片的说明）；
 * - **链接只认 http(s) 的绝对地址**（react-markdown 自己还会把 `javascript:` 这类协议去掉）：新窗口打开，不带来源页（`noreferrer`），
 *   链接文字和地址对不上时（文字不是地址本身），后面写出地址的主机名，模型不能把「官方文档」指到别处而看不出来；别的链接（相对地址……）
 *   只显示文字，不可点。
 *
 * 逐字出现时每来一段增量就重新解析一遍这一条：解析的是这一条自己，别的条目不重新渲染（`SessionTimeline` 的行是 `memo`）。
 */
export function AssistantMarkdown({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
			{text}
		</ReactMarkdown>
	);
}

/** 文字节点交给不可信文字组件；别的子节点（行内的强调、链接、代码）已经是我们的组件了，原样放。 */
function wrap(children: ReactNode): ReactNode {
	return Children.map(children, (child) =>
		typeof child === "string" ? <UntrustedText text={child} mode="text" /> : child,
	);
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

const COMPONENTS: Components = {
	h1: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{wrap(children)}</h3>,
	h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{wrap(children)}</h3>,
	h3: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{wrap(children)}</h4>,
	h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{wrap(children)}</h4>,
	h5: ({ children }) => <h5 className="mt-2 mb-1 text-sm font-semibold">{wrap(children)}</h5>,
	h6: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-semibold">{wrap(children)}</h6>,
	p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{wrap(children)}</p>,
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
	li: ({ children }) => <li>{wrap(children)}</li>,
	blockquote: ({ children }) => (
		<blockquote className="my-2 border-l-2 border-border-strong pl-3 text-fg-2 [&>p]:my-1">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-3 border-0 border-t border-border-soft" />,
	strong: ({ children }) => <strong className="font-semibold">{wrap(children)}</strong>,
	em: ({ children }) => <em>{wrap(children)}</em>,
	del: ({ children }) => <del>{wrap(children)}</del>,
	a: ({ href, children }) => {
		const host = linkHost(href);
		// 只认 http(s) 的绝对地址：别的只显示文字。
		if (host === null) return <>{wrap(children)}</>;
		const label = Children.toArray(children).join("");
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
				{wrap(children)}
				{!same && <span className="text-fg-3"> ({untrustedPlain(host)})</span>}
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
		<code className="rounded-sm bg-raised px-1 py-px font-mono text-xs text-fg-1">
			{wrap(children)}
		</code>
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
	th: ({ children }) => <TableHead>{wrap(children)}</TableHead>,
	td: ({ children }) => <TableCell>{wrap(children)}</TableCell>,
};
