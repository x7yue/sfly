import { Fragment } from "react";
import { isPlainText, type UntrustedMode, untrustedSegments } from "#/lib/untrusted-text";

/**
 * 显示「别人写的、平台不保证内容」的文字的公共组件（docs/DESIGN-SYSTEM.md「不可信的文字」，#699）：Agent 报的名称和版本、节点写的
 * 说明和输出、失败原因和出错位置、日志、动作的名称和字段、产物的名称、节点包的元信息、接口的错误信息……**这一类文字只经它显示**：
 *
 * - **文字方向隔离在自己的范围里，基准方向一律是从左到右**（`<bdi dir="ltr">`）：从右到左书写的文字自己成一段，不影响旁边的文字，
 *   也不会因为它在开头就把整行翻过来；整个控制台就是从左到右的基准方向，所以任何文字的显示都和不经它时一样，只是影响不到旁边了；
 * - **看不见的字符和控制字符写成看得见的样子**（`U+202E` 一小块，悬停和读屏有一句说明，选中复制出去是 `⟨U+202E⟩`）：改变文字方向的
 *   控制字符、零宽字符、终端的转义字符都不再生效，也藏不了内容。字符表和位置规则是 `@sfly/schema` 的 `text-safety.ts` 里那一份（见 `lib/untrusted-text`）；
 * - **普通的文字不包一层**：没有要写出来的字符、也没有从右到左书写的字母时，直接是文字节点（页面上的节点数和原来一样）。
 *
 * `mode`：`line`（默认）单行的名字，所有控制字符都写出来；`text` 可以多行的正文（失败原因、日志、输出），换行和制表符照常。
 * 属性里（`title`、`aria-label`）和按文字截断的地方放不了组件：用 `lib/untrusted-text` 的 `untrustedPlain`，或 `Truncate` 的 `untrusted`。
 */
export function UntrustedText({ text, mode = "line" }: { text: string; mode?: UntrustedMode }) {
	if (isPlainText(text, mode)) return text;
	return (
		<bdi dir="ltr">
			{untrustedSegments(text, mode).map((segment, index) =>
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

/**
 * 一个被写出来的字符：自己是从左到右的一小块，不被周围文字的方向带乱。选中复制出去的文字带尖括号（`⟨U+202E⟩`，
 * 和属性里 `untrustedPlain` 的写法一致）：不带的话，和原文里本来就写着「U+202E」的分不开。括号只给复制用（`sr-only`），显示不变。
 */
function HiddenCharacter({ label, name }: { label: string; name: string }) {
	return (
		<span
			dir="ltr"
			data-slot="hidden-character"
			title={name}
			role="img"
			aria-label={name}
			className="mx-px inline-block rounded-sm border border-border-strong bg-raised px-1 align-baseline font-mono text-[0.85em] leading-none whitespace-nowrap text-fg-2 not-italic [unicode-bidi:isolate]"
		>
			<span className="sr-only">⟨</span>
			{label}
			<span className="sr-only">⟩</span>
		</span>
	);
}
