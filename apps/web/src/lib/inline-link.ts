/**
 * 行内链接的样式（docs/DESIGN-SYSTEM.md「行内链接」）：夹在一句话里的链接用文字的 `fg-1`（比周围的 `fg-2`、`fg-3` 亮两档）
 * 加一条 `fg-3` 的下划线，悬停时下划线变 `fg-1`。不靠继承周围的文字色：周围是红字、灰字时链接照样认得出来。
 * 想让行内链接更醒目，只改这一处。按钮样子的链接（`Button`、`DocPageLink look="button"`）和表格里主链接的悬停下划线不是行内链接。
 */
export const INLINE_LINK =
	"text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1";

/**
 * 同一套样式，写给容器里直接的 `<a>` 子元素（`DialogDescription`）：Tailwind 只认完整的类名，所以写成静态的一份；
 * `inline-link.test.ts` 检查它和 {@link INLINE_LINK} 一致。
 */
export const INLINE_LINK_CHILDREN =
	"*:[a]:text-fg-1 *:[a]:underline *:[a]:decoration-fg-3 *:[a]:underline-offset-2 *:[a]:hover:decoration-fg-1";
