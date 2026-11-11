import { cn } from "cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import {
	type KeyLabel,
	type OperationKey,
	operationKey,
	type ShortcutId,
	shortcutKeys,
} from "#/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { writeClipboard } from "./feedback/clipboard";
import { notify } from "./feedback/notify";

/**
 * 外壳内页面的版式组件（原型 `.page` `.ph` `.panel` `.sec-h`）。页面结构：
 *
 *   <Page>
 *     <PageHeader title="Agent 管理" count={6} actions={<Button variant="ghost">…</Button>} />
 *     <Panel>…表格…</Panel>
 *   </Page>
 */

/**
 * 外壳内页面的内容容器：铺满侧栏右侧的宽度，两侧固定 32px 边距（不设最大宽度，大屏上不留大块空白）。
 * 需要限制阅读宽度的内容（文档正文）自己设宽度。
 */
export function Page({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("px-8 pt-5 pb-15", className)} {...props} />;
}

export function PageHeader({
	title,
	count,
	description,
	actions,
}: {
	title: string;
	/** 标题旁的数量（等宽、三级文字）。 */
	count?: number;
	description?: React.ReactNode;
	/** 右侧操作；白色主操作每屏最多一个。 */
	actions?: React.ReactNode;
}) {
	return (
		<div className="mb-3.5 flex items-center gap-2.5">
			<h1 className="m-0 text-lg font-semibold">{title}</h1>
			{count !== undefined && <span className="font-mono text-xs text-fg-3">{count}</span>}
			{description && <span className="text-sm text-fg-3">{description}</span>}
			<span className="flex-1" />
			{actions}
		</div>
	);
}

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
	return (
		<section
			className={cn("overflow-hidden rounded-lg border border-border-soft bg-surface", className)}
			{...props}
		/>
	);
}

/**
 * 小节标题，右侧延伸一条分隔线。默认 h3（面板内，上面有面板的 h2）；直接放在页面标题（h1）下时传 `level={2}`，
 * 标题层级不跳级。
 */
export function SectionHeading({
	className,
	level = 3,
	...props
}: React.ComponentProps<"h3"> & { level?: 2 | 3 }) {
	const Heading = level === 2 ? "h2" : "h3";
	return (
		<Heading
			className={cn(
				"mt-4 mb-2 flex items-center gap-2 text-xs font-medium text-fg-3 after:h-px after:flex-1 after:bg-border-soft",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * 快捷键的按键显示，`shortcut` 是注册表 id：`Ctrl+K` → <kbd>Ctrl</kbd><kbd>K</kbd>（同时按，紧挨着）；
 * `G D` → <kbd>G</kbd> 然后 <kbd>D</kbd>（依次按，中间写明「然后」）。
 */
export function Keys({ shortcut, className }: { shortcut: ShortcutId; className?: string }) {
	return <KeyChords chords={shortcutKeys(shortcut)} className={className} />;
}

/** 操作说明里的按键（命令面板底部的「↑ ↓ 选择」）：不是快捷键，见 OperationKey。快捷键用 Keys。 */
export function KeyHint({ keys, className }: { keys: OperationKey; className?: string }) {
	return <KeyChords chords={[[operationKey(keys)]]} className={className} />;
}

function KeyChords({ chords, className }: { chords: KeyLabel[][]; className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-0.75", className)}>
			{chords.map((chord, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 同一快捷键里可能有重复的键
				<span key={i} className="inline-flex items-center gap-0.75">
					{i > 0 && <span className="px-0.5 text-2xs text-fg-3">然后</span>}
					{chord.map((k, j) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 同上
						<Kbd key={j}>{k}</Kbd>
					))}
				</span>
			))}
		</span>
	);
}

/**
 * 命令 / 代码片段，右上角可以复制。`wrap`：给人读的整段文字（复制给 AI 编程助手的提示词），自动换行、用正文字体；
 * 命令和代码保持不换行、横向滚动，复制出来与看到的一致。
 */
export function CodeBlock({
	code,
	className,
	wrap = false,
}: {
	code: string;
	className?: string;
	wrap?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<div
			data-slot="code-block"
			className={cn("relative rounded-lg border border-border-soft bg-sunk", className)}
		>
			<pre
				className={cn(
					"m-0 px-3 py-2.5 pr-11 text-left leading-relaxed",
					wrap
						? "font-sans text-sm break-words whitespace-pre-wrap text-fg-1"
						: "overflow-x-auto font-mono text-xs whitespace-pre text-fg-2",
				)}
			>
				{code}
			</pre>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="复制"
				className="absolute top-1.5 right-1.5"
				onClick={() =>
					writeClipboard(code, () => {
						setCopied(true);
						notify.success("已复制到剪贴板");
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</div>
	);
}
