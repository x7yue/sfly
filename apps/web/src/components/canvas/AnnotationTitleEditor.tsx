import { ANNOTATION_TITLE_MAX } from "@sfly/schema";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";

/** 按字符（码点）截到标题的上限：原生的 maxLength 按 UTF-16 码元计，emoji 会少算。 */
const clamp = (text: string) => [...text].slice(0, ANNOTATION_TITLE_MAX).join("");

/**
 * 注释框标题的原地编辑（双击框外的标题胶囊、F2）：占着胶囊的位置，字号、留白和胶囊一样（类名由使用方给），
 * 编辑框的轮廓是内阴影。Enter、Tab、失焦确认，Esc 取消；输入法组字时 Enter、Esc 属于输入法。
 * 最多 40 个字符，多出来的不收；清空后确认等于不改（标题必填）。确认、取消后焦点回到画布区域，键盘接着操作；
 * 用鼠标点了别处（失焦）时不抢回焦点。
 */
export function AnnotationTitleEditor({
	initial,
	className,
	maxWidth,
	onCommit,
	onCancel,
}: {
	initial: string;
	className: string;
	maxWidth: number;
	onCommit(text: string): void;
	onCancel(): void;
}) {
	const [text, setText] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	const finished = useRef(false);

	// preventScroll：标题在带 transform 的画布里，浏览器为聚焦做的滚动会把整张画布推歪。
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
		input.current?.select();
	}, []);

	const finish = (action: () => void, restoreFocus: boolean) => {
		if (finished.current) return;
		finished.current = true;
		if (restoreFocus) {
			input.current?.closest<HTMLElement>("[data-canvas-region]")?.focus({ preventScroll: true });
		}
		action();
	};

	return (
		<input
			ref={input}
			value={text}
			aria-label="注释框的标题"
			// 宽度跟着文字走（field-sizing），撑到和标题胶囊一样的上限为止。
			style={{ maxWidth }}
			// nodrag / nopan / nowheel：在输入框里按住拖选文字不拖动成员，双击不触发画布的双击缩放。
			className={cn(
				"nodrag nopan nowheel pointer-events-auto min-w-[6em] border-0 outline-hidden inset-ring-1 inset-ring-signal [field-sizing:content]",
				className,
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
					// Tab 也在这里确认：不让编辑器把它当成「添加节点」。
					e.preventDefault();
					finish(() => onCommit(clamp(text)), true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					finish(onCancel, true);
				}
			}}
			onBlur={() => finish(() => onCommit(clamp(text)), false)}
			onContextMenu={(e) => e.stopPropagation()}
		/>
	);
}
