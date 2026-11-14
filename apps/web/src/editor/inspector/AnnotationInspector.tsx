import { nodeNameWithId, subflowLabel } from "@sfly/orchestration";
import { ANNOTATION_TITLE_MAX, type Annotation } from "@sfly/schema";
import { Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { memberCount } from "../annotations";
import { annotationFieldKey } from "../field-drafts";
import { Field, FieldList, SectionTitle } from "./fields";
import type { InspectorContext } from "./Inspector";
import { Header } from "./InspectorHeader";

interface Member {
	/** 节点 ID；子流程成员是子流程入口的节点 ID。 */
	id: string;
	label: string;
	exists: boolean;
	remove(annotation: Annotation): Annotation;
}

/**
 * 选中注释框时的检查器：标题、备注、成员列表（逐个移出、前往成员），删除注释框（成员节点不动）。
 * 标题和备注的连续输入各合成一步撤销；注释框不能没有成员，只剩一个时不能移出。
 * 输入框带 `data-field-key`（annotationFieldKey）：新建后、保存被字段错误拦下时，编辑器用它把焦点放过来。
 */
export function AnnotationInspector({
	annotation,
	context,
	onCollapse,
}: {
	annotation: Annotation;
	context: InspectorContext;
	onCollapse(): void;
}) {
	const { id } = annotation;
	const errorOf = (field: string) =>
		context.shownFieldErrors.find((e) => e.annotationId === id && e.field === field)?.message;
	const change = (next: Annotation, field?: string) => context.onChangeAnnotation(next, field);

	const nodes = new Map(context.doc.nodes.map((n) => [n.id, n]));
	const members: Member[] = [
		...annotation.nodes.map((nodeId): Member => {
			const node = nodes.get(nodeId);
			return {
				id: nodeId,
				label: node ? nodeNameWithId(node) : nodeId,
				exists: node !== undefined,
				remove: (a) => ({ ...a, nodes: a.nodes.filter((n) => n !== nodeId) }),
			};
		}),
		...annotation.subflows.map((entryId): Member => {
			const entry = nodes.get(entryId);
			return {
				id: entryId,
				label: `子流程 ${entry?.kind === "subflow_entry" ? subflowLabel(entry) : entryId}`,
				exists: entry?.kind === "subflow_entry",
				remove: (a) => ({ ...a, subflows: a.subflows.filter((s) => s !== entryId) }),
			};
		}),
	];
	const lastOne = memberCount(annotation) <= 1;

	return (
		<>
			<Header
				onCollapse={onCollapse}
				title={annotation.title.trim() || id}
				row={
					<>
						<span>注释框</span>
						<span className="font-mono text-fg-2">{id}</span>
					</>
				}
				actions={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="删除注释框"
						onClick={() => context.onDeleteAnnotation(id)}
					>
						<Trash2Icon />
					</Button>
				}
			/>
			<FieldList className="flex-none border-b border-border-soft px-3.5 pt-3">
				<Field
					label="标题"
					required
					error={errorOf("title")}
					fieldKey={annotationFieldKey(id, "title")}
				>
					{(control) => (
						<Input
							{...control}
							value={annotation.title}
							placeholder={`这一组节点在做什么（最多 ${ANNOTATION_TITLE_MAX} 个字符）`}
							onChange={(e) => change({ ...annotation, title: e.target.value }, "title")}
						/>
					)}
				</Field>
				<Field label="备注" error={errorOf("note")} fieldKey={annotationFieldKey(id, "note")}>
					{(control) => (
						<Textarea
							{...control}
							value={annotation.note ?? ""}
							placeholder="怎么做、为什么这样做（可选）"
							onChange={(e) =>
								change(
									{ ...annotation, note: e.target.value === "" ? undefined : e.target.value },
									"note",
								)
							}
						/>
					)}
				</Field>
			</FieldList>
			<div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
				<SectionTitle>成员</SectionTitle>
				<ul aria-label="成员" className="m-0 flex list-none flex-col gap-1 p-0">
					{members.map((m, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: 同一个成员可能写了两次（来自命令行），只能按位置区分
							key={i}
							className="flex items-center gap-1 rounded-md bg-raised py-0.5 pr-0.5 pl-2.5 text-sm"
						>
							<span className="min-w-0 flex-1 truncate">{m.label}</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`前往 ${m.label}`}
								disabled={!m.exists}
								onClick={() => context.onLocate(m.id)}
							>
								前往
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`移出 ${m.label}`}
								disabled={lastOne}
								onClick={() => change(m.remove(annotation))}
							>
								<XIcon />
							</Button>
						</li>
					))}
				</ul>
				<p className="m-0 mt-2 text-xs text-fg-3">
					{lastOne && "注释框至少要有一个成员。"}
					用节点的右键菜单把节点加入或移出注释框；删除注释框时，里面的节点不动。
				</p>
			</div>
		</>
	);
}
