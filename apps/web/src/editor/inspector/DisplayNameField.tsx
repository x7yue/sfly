import type { DocNode } from "#/components/canvas/flow";
import { Input } from "@/components/ui/input";
import { draftKey } from "../field-drafts";
import { Field, FieldList } from "./fields";

/** 可以起显示名称的节点：子流程入口节点没有，它的名称就是子流程名称。 */
export type NamedNode = Exclude<DocNode, { kind: "subflow_entry" }>;

export const isNamedNode = (node: DocNode): node is NamedNode => node.kind !== "subflow_entry";

/**
 * 检查器顶部的「显示名称」：占位文字是当前的默认标题（节点类型标题、「等待 30s」……）。
 * 输入框里是原样输入的文字，只有空白当作没写；保存时去掉首尾空白（@sfly/schema 的 optionalLine）。
 * 超长（按字符计，emoji 算一个）或带换行是字段错误，显示在输入框下面。
 */
export function DisplayNameField({
	id,
	node,
	placeholder,
	error,
	onChange,
}: {
	id: string;
	node: NamedNode;
	placeholder: string;
	error: string | undefined;
	onChange(node: NamedNode): void;
}) {
	return (
		<FieldList className="flex-none border-b border-border-soft px-3.5 pt-3">
			<Field label="显示名称" error={error} fieldKey={draftKey(id, "display_name")}>
				{(control) => (
					<Input
						{...control}
						value={node.display_name ?? ""}
						placeholder={placeholder}
						onChange={(e) =>
							onChange({
								...node,
								display_name: e.target.value === "" ? undefined : e.target.value,
							})
						}
					/>
				)}
			</Field>
		</FieldList>
	);
}
