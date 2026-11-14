import { DISPLAY_NAME_MAX } from "@sfly/schema";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { ZOOM_TEXT_TITLE } from "./zoom-text";

/** 按字符（码点）截到显示名称的上限：原生的 maxLength 按 UTF-16 码元计，emoji 会少算。 */
const clamp = (text: string) => [...text].slice(0, DISPLAY_NAME_MAX).join("");

/**
 * 节点卡片标题的原地编辑（改显示名称）：占着标题的位置，字号、行高与标题一致、高度正好是一行标题，所以卡片尺寸不变
 * （没有边框，编辑框的轮廓是内阴影）。Enter、Tab、失焦确认，Esc 取消；输入法组字时 Enter、Esc 属于输入法。
 * `initial` 是现有的显示名称，没有时为空，`placeholder` 是默认标题。
 *
 * 输入框里的文字最多 40 个字符，多出来的不收，所以确认时不会出现字段错误。确认、取消后焦点回到节点卡片，
 * 键盘接着操作；用鼠标点了别处（失焦）时不抢回焦点。
 */
export function NodeTitleEditor({
	id,
	initial,
	placeholder,
	onCommit,
	onCancel,
}: {
	id: string;
	initial: string;
	placeholder: string;
	onCommit(text: string): void;
	onCancel(): void;
}) {
	const [text, setText] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	const finished = useRef(false);

	// preventScroll：卡片在带 transform 的画布里，浏览器为聚焦做的滚动会把整张画布推歪。
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
		input.current?.select();
	}, []);

	const finish = (action: () => void, restoreFocus: boolean) => {
		if (finished.current) return;
		finished.current = true;
		if (restoreFocus) {
			input.current?.closest<HTMLElement>("[data-node-id]")?.focus({ preventScroll: true });
		}
		action();
	};

	return (
		<input
			ref={input}
			value={text}
			placeholder={placeholder}
			aria-label={`节点 ${id} 的显示名称`}
			// nodrag / nopan / nowheel：在输入框里按住拖选文字不拖动节点，双击不触发画布的双击缩放。
			className={cn(
				"nodrag nopan nowheel mt-1.5 mb-1.25 -mx-1 block h-[1.6em] w-[calc(100%+0.5rem)] min-w-0 rounded-sm border-0 bg-sunk px-1 font-semibold text-fg-1 outline-hidden inset-ring-1 inset-ring-signal placeholder:font-normal placeholder:text-fg-3",
				"leading-[1.6]",
				ZOOM_TEXT_TITLE,
			)}
			onChange={(e) => {
				// 组字过程中不动输入框里的文字，否则会打断输入法；确认时再截。
				const composing = (e.nativeEvent as InputEvent).isComposing;
				setText(composing ? e.target.value : clamp(e.target.value));
			}}
			onKeyDown={(e) => {
				// keyCode 229：Safari 在组字结束的那次按键上 isComposing 已经是 false。
				if (e.nativeEvent.isComposing || e.keyCode === 229) return;
				if (e.key === "Enter" || e.key === "Tab") {
					// Tab 也在这里确认：不让编辑器把它当成「在节点后面添加」。
					e.preventDefault();
					finish(() => onCommit(clamp(text)), true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					finish(onCancel, true);
				}
			}}
			onBlur={() => finish(() => onCommit(clamp(text)), false)}
			// 在输入框里右键是文字的菜单（粘贴等），不是节点菜单。
			onContextMenu={(e) => e.stopPropagation()}
		/>
	);
}
