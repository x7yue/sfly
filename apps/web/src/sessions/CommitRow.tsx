import { ChevronRightIcon, GitCommitHorizontalIcon } from "lucide-react";
import { useId, useState } from "react";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";
import { commitSummary, shortHash } from "./session-text";
import type { CommitItem } from "./timeline";

/**
 * 平台在一轮结束时提交工作区的记录（#546，`platform` 事件的 `commit`）：一行「这一轮改了 N 个文件 +a −b」和短提交号，默认折叠，
 * 展开是文件列表（每个文件的增删行数，二进制写「二进制文件」）和提交那一刻的差异；差异太长只存了开头时写明。
 * 和「助手的话」「工具调用」明显不同：带提交图标、整行是平台写的摘要。统一的样式在 #550。
 * 文件的路径和差异是模型写的东西，经不可信文字组件显示（docs/DESIGN-SYSTEM.md §6.8）。
 */
export function CommitRow({ item }: { item: CommitItem }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<li
			data-testid="commit-row"
			data-leftover={item.leftover || undefined}
			className="overflow-hidden rounded-lg border border-border-soft bg-surface"
		>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-raised"
			>
				<ChevronRightIcon
					aria-hidden
					className="size-3.5 flex-none text-fg-3 transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
					style={{ rotate: open ? "90deg" : "0deg" }}
				/>
				<GitCommitHorizontalIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
				<span data-testid="commit-summary" className="min-w-0 flex-1 text-fg-1">
					{commitSummary(item)}
				</span>
				<span data-testid="commit-hash" title={item.hash} className="flex-none font-mono text-fg-3">
					<span className="sr-only">{SESSION.commit.hash} </span>
					{shortHash(item.hash)}
				</span>
			</button>
			{open && (
				<div id={bodyId} className="border-t border-border-soft bg-sunk">
					<ul
						aria-label={SESSION.commit.files}
						data-testid="commit-files"
						className="m-0 flex list-none flex-col gap-0.5 px-3 py-2"
					>
						{item.files.map((file) => (
							<li
								key={file.path}
								data-testid="commit-file"
								className="flex min-w-0 items-center gap-3 font-mono text-xs"
							>
								<Truncate untrusted className="flex-1 text-fg-1">
									{file.path}
								</Truncate>
								{file.additions === null || file.deletions === null ? (
									<span className="flex-none text-fg-3">{SESSION.commit.binary}</span>
								) : (
									<span className="flex flex-none gap-2">
										<span className="text-ok">{SESSION.commit.additions(file.additions)}</span>
										<span className="text-danger-fg">
											{SESSION.commit.deletions(file.deletions)}
										</span>
									</span>
								)}
							</li>
						))}
					</ul>
					<pre
						data-testid="commit-diff"
						className="m-0 max-h-96 overflow-auto border-t border-border-soft px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-fg-2"
					>
						<UntrustedText text={item.diff} mode="text" />
					</pre>
					{item.truncated && (
						<p
							data-testid="commit-truncated"
							className="m-0 border-t border-border-soft px-3 py-2 text-xs text-fg-3"
						>
							{SESSION.commit.truncated}
						</p>
					)}
				</div>
			)}
		</li>
	);
}
