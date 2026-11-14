import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";

/**
 * 检查器顶部的「备注」：多行说明，写这个节点在场景里做什么、为什么这样配置。所有节点种类都有。
 * 保存时去掉首尾空白，只有空白等于没写；超过上限的错误显示在输入框下面（文档校验给出，字段错误阻止保存）。
 */
export function NoteField({
	note,
	error,
	onChange,
}: {
	note: string | undefined;
	error: string | undefined;
	onChange(note: string | undefined): void;
}) {
	return (
		<div className="flex-none border-b border-border-soft px-3.5 py-2.5">
			<FormField label="备注" error={error}>
				{(control) => (
					<Textarea
						{...control}
						value={note ?? ""}
						placeholder="这个节点做什么、为什么这样配置（可选）"
						onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
					/>
				)}
			</FormField>
		</div>
	);
}
