import { cn } from "cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { keyLabels } from "#/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { notify } from "./feedback/notify";

/**
 * 外壳内页面的版式组件（原型 `.page` `.ph` `.panel` `.sec-h`）。页面结构：
 *
 *   <Page>
 *     <PageHeader title="Agent 管理" count={6} actions={<Button variant="ghost">…</Button>} />
 *     <Panel>…表格…</Panel>
 *   </Page>
 */

export function Page({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("mx-auto max-w-[1360px] px-6 pt-5 pb-15", className)} {...props} />;
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

/** 面板内的小节标题，右侧延伸一条分隔线。 */
export function SectionHeading({ className, ...props }: React.ComponentProps<"h3">) {
	return (
		<h3
			className={cn(
				"mt-4 mb-2 flex items-center gap-2 text-xs font-medium text-fg-3 after:h-px after:flex-1 after:bg-border-soft",
				className,
			)}
			{...props}
		/>
	);
}

/** 快捷键的按键显示：`Ctrl+K` → <kbd>Ctrl</kbd><kbd>K</kbd>。 */
export function Keys({ keys, className }: { keys: string; className?: string }) {
	return (
		<span className={cn("inline-flex gap-0.75", className)}>
			{keyLabels(keys).map((k, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 同一快捷键里可能有重复的键
				<Kbd key={i}>{k}</Kbd>
			))}
		</span>
	);
}

/** 命令 / 代码片段，右上角可以复制。 */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div
			data-slot="code-block"
			className={cn("relative rounded-lg border border-border-soft bg-sunk", className)}
		>
			<pre className="m-0 overflow-x-auto px-3 py-2.5 pr-11 text-left font-mono text-xs leading-relaxed whitespace-pre text-fg-2">
				{code}
			</pre>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="复制"
				className="absolute top-1.5 right-1.5"
				onClick={() => {
					void navigator.clipboard
						.writeText(code)
						.then(() => {
							setCopied(true);
							notify.success("已复制到剪贴板");
							setTimeout(() => setCopied(false), 1500);
						})
						.catch(() => notify.error("复制失败", { description: "浏览器不允许访问剪贴板" }));
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</div>
	);
}
