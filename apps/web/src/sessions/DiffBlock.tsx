import { cn } from "cn";
import { UntrustedText } from "#/components/untrusted-text";

/** 差异里的一行是什么：增、删、头（文件名、行号范围）、上下文。 */
export type DiffLineKind = "add" | "del" | "meta" | "context";

/**
 * 差异的一行按开头的字符分类。`+++`、`---` 开头的是文件名那两行（头），不是增删；`@@` 是行号范围，`diff --git`、`index …`、
 * `new file mode` 这些也是头。pi 的编辑结果里的差异（`+12 新的一行`、`-12 旧的一行`、` 12 没动的一行`）和 git 的差异都按这个读。
 */
export function diffLineKind(line: string): DiffLineKind {
	if (line.startsWith("+++") || line.startsWith("---")) return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	if (
		line.startsWith("@@") ||
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("new file") ||
		line.startsWith("deleted file") ||
		line.startsWith("similarity ") ||
		line.startsWith("rename ") ||
		line.startsWith("Binary files")
	) {
		return "meta";
	}
	return "context";
}

const TONE: Record<DiffLineKind, string> = {
	add: "text-ok",
	del: "text-danger-fg",
	meta: "text-fg-3",
	context: "text-fg-2",
};

/**
 * 差异：增的行绿、删的行红、头和行号范围灰、没动的行次要文字色；颜色之外增删靠行首的 `+`、`-`（原文就有的字符），所以色觉缺陷、
 * 强制颜色下读起来一样。每一行自己带着结尾的换行，`<pre>` 里的文字和原文逐字一样（复制出去、读屏读到的都是原文）。
 * 文字是模型写的东西，每一行都经不可信文字组件（docs/DESIGN-SYSTEM.md「不可信的文字」）。
 */
export function DiffBlock({
	diff,
	testId,
	className,
}: {
	diff: string;
	testId?: string;
	className?: string;
}) {
	const lines = diff.split("\n");
	// 末尾的换行是最后一行的结束，不是多出来的一个空行。
	const last = lines.at(-1) === "" ? lines.length - 1 : lines.length;
	return (
		<pre
			data-testid={testId}
			className={cn(
				"m-0 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-fg-2",
				className,
			)}
		>
			{lines.slice(0, last).map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 差异的行按位置排，内容变了整块重排
				<span key={index} data-diff={diffLineKind(line)} className={TONE[diffLineKind(line)]}>
					{/* 换行和这一行一起交给组件：CRLF 的文件里行尾的回车是排版，不写成占位。 */}
					<UntrustedText
						text={index < last - 1 || lines.at(-1) === "" ? `${line}\n` : line}
						mode="text"
					/>
				</span>
			))}
		</pre>
	);
}
