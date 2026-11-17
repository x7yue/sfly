import { ANNOTATION_TITLE_MAX, STICKY_NOTE_TEXT_MAX, type StickyNote } from "@sfly/schema";
import { Trash2Icon } from "lucide-react";
import { AnnotationColorPicker } from "#/components/canvas/AnnotationColorPicker";
import { TERM } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { withStickyColor } from "../annotations";
import { stickyFieldKey } from "../field-drafts";
import { Field, FieldList } from "./fields";
import type { InspectorContext } from "./Inspector";
import { Header } from "./InspectorHeader";

/**
 * 选中便签时的检查器（ADR 0026）：标题、正文、颜色，删除便签。标题和正文的连续输入各合成一步撤销，
 * 换一次颜色是一步；选黄色时去掉 `color`（不写就是黄色）。正文必填：清空时是字段错误，不能保存。
 * 输入框带 `data-field-key`（stickyFieldKey）：新建后、保存被字段错误拦下时，编辑器用它把焦点放过来。
 */
export function StickyInspector({
	note,
	context,
	onCollapse,
}: {
	note: StickyNote;
	context: InspectorContext;
	onCollapse(): void;
}) {
	const { id } = note;
	const errorOf = (field: string) =>
		context.shownFieldErrors.find((e) => e.stickyId === id && e.field === field)?.message;
	const change = (next: StickyNote, field?: string) => context.onChangeSticky(next, field);
	return (
		<>
			<Header
				onCollapse={onCollapse}
				title={note.title?.trim() || TERM.stickyNote}
				row={
					<>
						<span>{TERM.stickyNote}</span>
						<span className="font-mono text-fg-2">{id}</span>
					</>
				}
				actions={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="删除便签"
						onClick={() => context.onDeleteSticky(id)}
					>
						<Trash2Icon />
					</Button>
				}
			/>
			<FieldList data-focus-start="" className="min-h-0 flex-1 overflow-auto px-3.5 pt-3">
				<Field label="标题" error={errorOf("title")} fieldKey={stickyFieldKey(id, "title")}>
					{(control) => (
						<Input
							{...control}
							value={note.title ?? ""}
							placeholder={`加粗显示在第一行（可选，最多 ${ANNOTATION_TITLE_MAX} 个字符）`}
							onChange={(e) =>
								change(
									{ ...note, title: e.target.value === "" ? undefined : e.target.value },
									"title",
								)
							}
						/>
					)}
				</Field>
				<Field
					label="正文"
					required
					error={errorOf("text")}
					help={`以「- 」开头的行显示成列表（最多 ${STICKY_NOTE_TEXT_MAX} 个字符）`}
					fieldKey={stickyFieldKey(id, "text")}
				>
					{(control) => (
						<Textarea
							{...control}
							value={note.text}
							rows={8}
							placeholder="检查清单、已知问题、待办……"
							onChange={(e) => change({ ...note, text: e.target.value }, "text")}
						/>
					)}
				</Field>
				<Field label="颜色">
					{(control) => (
						<AnnotationColorPicker
							id={control.id}
							aria-labelledby={`${control.id}-label`}
							value={note.color ?? "yellow"}
							onChange={(color) => change(withStickyColor(note, color))}
						/>
					)}
				</Field>
			</FieldList>
		</>
	);
}
