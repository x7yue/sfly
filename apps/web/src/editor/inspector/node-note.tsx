import { Textarea } from "@/components/ui/textarea";
import { draftKey } from "../field-drafts";
import { Field } from "./fields";

/**
 * 检查器顶部的「备注」：多行说明，写这个节点在场景里做什么、为什么这样配置。所有节点种类都有。
 * 输入框里是原样输入的文字，只有空白当作没写；保存时去掉首尾空白（@sfly/schema 的 optionalMultiline）。
 * 超过上限的错误显示在输入框下面（字段错误阻止保存）。必须放在 `FieldList` 里（检查器顶部和显示名称一起）。
 */
export function NoteField({
	id,
	note,
	error,
	onChange,
}: {
	id: string;
	note: string | undefined;
	error: string | undefined;
	onChange(note: string | undefined): void;
}) {
	return (
		<Field label="备注" error={error} fieldKey={draftKey(id, "note")}>
			{(control) => (
				<Textarea
					{...control}
					value={note ?? ""}
					placeholder="这个节点做什么、为什么这样配置（可选）"
					onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
				/>
			)}
		</Field>
	);
}
