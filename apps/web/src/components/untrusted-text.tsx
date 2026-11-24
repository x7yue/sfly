import { cn } from "cn";
import { Fragment } from "react";
import { type UntrustedMode, untrustedSegments } from "#/lib/untrusted-text";

/**
 * 显示「别人写的、平台不保证内容」的文字的公共组件（docs/DESIGN-SYSTEM.md「不可信的文字」，#699）：Agent 报的名称和版本、节点写的
 * 说明和输出、失败原因和出错位置、日志、动作的名称和字段、产物的名称、节点包的元信息……**这一类文字只经它显示**：
 *
 * - **文字方向隔离在自己的范围里**（`<bdi>`：隔离、方向跟着文字自己的字母走）：从右到左书写的文字照常显示，不影响旁边的文字；
 * - **看不见的字符和控制字符写成看得见的样子**（`U+202E` 一小块，悬停和读屏有一句说明）：改变文字方向的控制字符、零宽字符、
 *   终端的转义字符都不再生效，也藏不了内容。字符表是 `@sfly/schema` 的 `text-safety.ts` 里那一张（见 `lib/untrusted-text`）。
 *
 * `mode`：`line`（默认）单行的名字，所有控制字符都写出来；`text` 可以多行的正文（失败原因、日志、输出），换行和制表符照常。
 * 属性里（`title`、`aria-label`）和按文字截断的地方放不了组件：用 `lib/untrusted-text` 的 `untrustedPlain`，或 `Truncate` 的 `untrusted`。
 * 没有要写出来的字符时只多一个 `<bdi>`，一行日志多一次正则匹配。
 */
export function UntrustedText({
	text,
	mode = "line",
	className,
}: {
	text: string;
	mode?: UntrustedMode;
	className?: string;
}) {
	const segments = untrustedSegments(text, mode);
	return (
		<bdi className={className}>
			{segments.map((segment, index) =>
				segment.kind === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 段按顺序切出来，文字变了整个重排
					<Fragment key={index}>{segment.text}</Fragment>
				) : (
					<HiddenCharacter
						// biome-ignore lint/suspicious/noArrayIndexKey: 同上
						key={index}
						label={segment.label}
						name={segment.name}
					/>
				),
			)}
		</bdi>
	);
}

/** 一个被写出来的字符：自己是从左到右的一小块，不被周围文字的方向带乱。 */
function HiddenCharacter({ label, name }: { label: string; name: string }) {
	return (
		<span
			dir="ltr"
			data-slot="hidden-character"
			title={name}
			role="img"
			aria-label={name}
			className={cn(
				"mx-px inline-block rounded-sm border border-border-strong bg-raised px-1 align-baseline font-mono text-[0.85em] leading-none whitespace-nowrap text-fg-2 not-italic [unicode-bidi:isolate]",
			)}
		>
			{label}
		</span>
	);
}
