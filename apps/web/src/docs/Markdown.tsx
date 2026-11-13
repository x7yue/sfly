import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "#/components/page";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 用户文档的 Markdown 渲染（ADR 0013）：标题、段落、列表、表格（GFM）、引用、行内代码、链接和代码块。
 * 代码块用 CodeBlock（带复制按钮）；不渲染原始 HTML。
 *
 * 链接：文档之间写相对的 `<slug>.md`（curl 读原文时也能按相对地址找到），这里换成文档页 `/docs/<slug>`；
 * 以 `/` 开头的是前端页面，在应用内跳转；其余（http 等）在新窗口打开。
 */
export function Markdown({ source }: { source: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
			{source}
		</ReactMarkdown>
	);
}

/** 文档链接 → 前端地址；不是文档链接时为 undefined。 */
export function docHref(href: string): string | undefined {
	const match = /^(?:\.\/|\/docs\/)?([a-z0-9][a-z0-9-]*)\.md(#.*)?$/.exec(href);
	return match ? `/docs/${match[1]}${match[2] ?? ""}` : undefined;
}

const LINK = "text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1";

function DocLink({ href = "", children }: { href?: string; children?: React.ReactNode }) {
	const router = useRouter();
	const internal = docHref(href) ?? (href.startsWith("/") ? href : undefined);
	if (internal === undefined) {
		return (
			<a href={href} target="_blank" rel="noreferrer" className={LINK}>
				{children}
			</a>
		);
	}
	return (
		<a
			href={internal}
			className={LINK}
			onClick={(event) => {
				if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
				event.preventDefault();
				router.history.push(internal);
			}}
		>
			{children}
		</a>
	);
}

/** 代码块的文字：`<pre><code>…</code></pre>`，去掉末尾的换行。 */
/** 代码块的语言（```后面的标记）；react-markdown 写在 <code> 的 className 上：language-xxx。 */
function codeLanguage(children: React.ReactNode): string | undefined {
	if (!isValidElement<{ className?: string }>(children)) return undefined;
	return /\blanguage-(\S+)/.exec(children.props.className ?? "")?.[1];
}

function codeText(children: React.ReactNode): string {
	const code = isValidElement<{ children?: React.ReactNode }>(children)
		? children.props.children
		: children;
	return String(code ?? "").replace(/\n$/, "");
}

const PROSE = "max-w-[42em] leading-5.5 text-pretty";

// 雅黑没有 500 字重，标题层级靠字号和 font-semibold 拉开，不用 font-medium。
const COMPONENTS: Components = {
	h1: ({ children }) => <h1 className="m-0 mb-4 text-2xl font-semibold">{children}</h1>,
	h2: ({ children }) => (
		<h2 className="mt-8 mb-3 border-b border-border-soft pb-1.5 text-lg font-semibold">
			{children}
		</h2>
	),
	h3: ({ children }) => <h3 className="mt-6 mb-2 text-base font-semibold">{children}</h3>,
	h4: ({ children }) => <h4 className="mt-4 mb-2 text-sm font-semibold text-fg-2">{children}</h4>,
	p: ({ children }) => <p className={cn("my-3", PROSE)}>{children}</p>,
	ul: ({ children }) => (
		<ul className="my-3 list-disc space-y-1 pl-5 marker:text-fg-3 [&_ol]:my-1 [&_ul]:my-1">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="my-3 list-decimal space-y-1 pl-5 marker:text-fg-3 [&_ol]:my-1 [&_ul]:my-1">
			{children}
		</ol>
	),
	li: ({ children }) => <li className={PROSE}>{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="my-3 max-w-[42em] border-l-2 border-border-strong pl-3 text-fg-2 [&>p]:my-1">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-6 border-0 border-t border-border-soft" />,
	a: ({ href, children }) => <DocLink href={href}>{children}</DocLink>,
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	code: ({ children }) => (
		<code className="rounded-sm bg-raised px-1 py-px font-mono text-xs text-fg-1 in-[h1]:bg-transparent in-[h1]:px-0 in-[h1]:text-lg in-[h2]:bg-transparent in-[h2]:px-0 in-[h2]:text-base in-[h3]:bg-transparent in-[h3]:px-0 in-[h3]:text-sm in-[h4]:bg-transparent in-[h4]:px-0">
			{children}
		</code>
	),
	// ```prompt：给人读、复制给 AI 编程助手的提示词，自动换行；其余代码块（命令、目录树、编排示意）不换行。
	pre: ({ children }) => (
		<CodeBlock
			code={codeText(children)}
			wrap={codeLanguage(children) === "prompt"}
			className="my-3"
		/>
	),
	table: ({ children }) => (
		<div className="my-3 overflow-hidden rounded-lg border border-border-soft">
			<Table scroll="x">{children}</Table>
		</div>
	),
	thead: ({ children }) => <TableHeader>{children}</TableHeader>,
	tbody: ({ children }) => <TableBody>{children}</TableBody>,
	tr: ({ children }) => <TableRow>{children}</TableRow>,
	th: ({ children }) => <TableHead>{children}</TableHead>,
	td: ({ children }) => <TableCell>{children}</TableCell>,
};
