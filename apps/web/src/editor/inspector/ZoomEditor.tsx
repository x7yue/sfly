import { Maximize2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ACTION } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	InsertReferenceButton,
	ReferenceEditor,
	type ReferenceEditorHandle,
} from "./ReferenceEditor";
import type { ReferenceChoice } from "./reference-completion";

/**
 * 字符串、JSON 字段旁的「放大编辑」按钮：打开一个等宽字体的大弹窗，里面是同一个 ReferenceEditor（补全、引用高亮）。
 * 弹窗里的每次修改都直接走字段自己的 onChange，和在检查器里输入完全一样（撤销历史、本地草稿、字段校验），
 * 所以没有「保存 / 放弃」，关闭后检查器里已经是同一个值。
 */
export function ZoomEditor({
	name,
	label,
	value,
	choices,
	placeholder,
	invalid,
	error,
	onChange,
}: {
	/** 字段名：用在按钮的无障碍名称和弹窗标题里。 */
	name: string;
	/** 检查器里这个输入框的无障碍名称；弹窗里的输入框在后面加「（放大编辑）」。 */
	label: string;
	value: string;
	/** null：这个字段不能写引用。 */
	choices: readonly ReferenceChoice[] | null;
	placeholder?: string;
	invalid?: boolean;
	/** 显示在输入框下面的错误与警告。 */
	error?: ReactNode;
	onChange(value: string): void;
}) {
	const [open, setOpen] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const editor = useRef<ReferenceEditorHandle>(null);
	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="flex-none"
				aria-label={`放大编辑 ${name}`}
				title="放大编辑"
				onClick={() => setOpen(true)}
			>
				<Maximize2Icon />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					// 补全列表在输入框下方展开，可以超出弹窗的下边缘。
					className="top-[8vh] max-h-none w-[960px] overflow-visible"
					initialFocus={() => body.current?.querySelector<HTMLElement>('[role="combobox"]') ?? true}
					// 弹窗在 React 树里是检查器的后代：不让这里的按键（Esc）冒泡成「离开检查器」。
					onKeyDown={(e) => e.stopPropagation()}
				>
					<DialogHeader>
						<DialogTitle>
							编辑 <span className="font-mono">{name}</span>
						</DialogTitle>
						<DialogDescription>
							{choices
								? `修改立即生效，可以撤销。输入 $ 或点「${ACTION.insertReference}」插入引用。`
								: "修改立即生效，可以撤销。"}
						</DialogDescription>
					</DialogHeader>
					<div ref={body} className="flex min-w-0 items-start gap-1.5">
						<div className="min-w-0 flex-1">
							<ReferenceEditor
								ref={editor}
								label={`${label}（放大编辑）`}
								value={value}
								choices={choices}
								placeholder={placeholder}
								invalid={invalid}
								minLines={18}
								maxLines={26}
								className="text-sm"
								onChange={onChange}
							/>
						</div>
						{choices && <InsertReferenceButton name={name} editor={editor} />}
					</div>
					{error && <div className="text-xs text-danger-fg">{error}</div>}
					<DialogFooter>
						<Button onClick={() => setOpen(false)}>完成</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
