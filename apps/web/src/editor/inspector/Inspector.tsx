import {
	dispatchTarget,
	isAnnotationWarning,
	type NodeTypeIo,
	nameWithId,
	nodeCardText,
	nodeDefaultTitle,
	nodeNameWithId,
	type OrchestrationWarning,
	type PackageCatalog,
	undeclaredInputs,
} from "@sfly/orchestration";
import {
	type AgentView,
	type Annotation,
	type FeishuBotView,
	type PackageSummary,
	REMOVED_NODE_KIND_NAMES,
	type RemovedNodeKind,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { cn } from "cn";
import { SquareDashedIcon, Trash2Icon } from "lucide-react";
import { forwardRef, useEffect, useMemo, useState } from "react";
import type { CanvasInfo } from "#/components/canvas/context";
import { type DocNode, isRemovedDocNode } from "#/components/canvas/flow";
import { KIND_META } from "#/components/canvas/node-display";
import {
	type CanvasSelection,
	multipleNodes,
	selectedAnnotation,
	soleNode,
} from "#/components/canvas/selection";
import { StatusPill } from "#/components/status";
import { FocusListPage } from "#/focus/FocusList";
import { isSavedNodeType } from "#/focus/saved-node";
import { useFocusItems } from "#/focus/use-focus-items";
import { ACTION, ANNOTATION_FIELD_LABEL, INSPECTOR_PAGE } from "#/lib/copy";
import { descriptionParagraphs } from "#/lib/node-description";
import { MetricDeclarations, type NodeMetricsInfo } from "#/metrics/MetricDeclarations";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { completionCatalog, inspectorNodeType, uncheckedInputs } from "../catalog";
import { fieldErrorKey } from "../field-drafts";
import { fieldLabel } from "../field-label";
import { checkSummary, type FieldError } from "../validation";
import { AgentSelect } from "./AgentSelect";
import { AnnotationInspector } from "./AnnotationInspector";
import { DisplayNameField, isNamedNode } from "./DisplayNameField";
import { FIELD_LIST_CLASS, Field, FieldList, focusField, SectionTitle } from "./fields";
import { Header } from "./InspectorHeader";
import { InspectorWidthHandle, useInspectorWidth } from "./inspector-width";
import { NodeOutputs } from "./NodeOutputs";
import {
	AsyncMapping,
	ExecutionSettings,
	PackageParams,
	PackageVersionField,
	StopSubflowField,
	SubflowNameField,
	SubflowTrigger,
} from "./node-forms";
import { NoteField } from "./node-note";
import { ParamsEditor } from "./ParamsEditor";
import { RemovedNodePanel } from "./RemovedNodePanel";
import { referenceChoices } from "./reference-completion";

/** 把焦点放到某个字段：`key` 是字段的草稿键（field-drafts.tsx），每次请求的 `nonce` 不同。 */
export interface FocusRequest {
	key: string;
	nonce: number;
}

const tabOfField = (key: string): Tab =>
	/^[^/]*\/(timeout|retries|queue_timeout)$/.test(key) ? "exec" : "params";

/** 检查器需要的场景级上下文。 */
export interface InspectorContext {
	/** 场景的 ID：关注项存在场景的设置里，检查器直接读写。 */
	orchestrationId: string;
	/** 画布上正在编辑的文档。 */
	doc: StoredOrchestrationDocument;
	/** 编辑起点：已保存的版本。关注项只能引用已保存的节点，新加的节点要先保存。 */
	saved: StoredOrchestrationDocument;
	catalog: PackageCatalog;
	info: CanvasInfo;
	packages: PackageSummary[] | undefined;
	agents: AgentView[];
	/** 已登记的飞书机器人（「飞书机器人」类型的输入的下拉框）。 */
	bots: FeishuBotView[];
	warnings: OrchestrationWarning[];
	shownFieldErrors: FieldError[];
	focusRequest: FocusRequest | null;
	onChangeNode(id: string, node: DocNode): void;
	onDefaultAgent(agent: string | undefined): void;
	onLock(name: string, version: string): void;
	/** 选中并定位到另一个节点。 */
	onLocate(id: string): void;
	/** 删除节点（多选时是整组，算一步撤销）。 */
	onDelete(ids: readonly string[]): void;
	/** 用选中的一组节点新建注释框。 */
	onAddAnnotation(ids: readonly string[]): void;
	/** 改注释框；同一个字段（`field`）的连续修改合成一步撤销。 */
	onChangeAnnotation(annotation: Annotation, field?: string): void;
	/** 删除注释框，成员节点不动。 */
	onDeleteAnnotation(id: string): void;
	/** 选中注释框（检查结果里的「前往」）。 */
	onLocateAnnotation(id: string): void;
}

/**
 * 右侧检查器（原型 `.insp`，可收起）。选中一个节点时：标题区 + 页签（参数 / 执行 / 说明）；
 * 选中多个节点时：「已选 N 个节点」和对这组节点的操作；选中注释框时：标题、备注和成员（AnnotationInspector）；
 * 什么都没选时：场景级设置（默认 Agent、节点包版本、检查结果）。
 * 包节点的「说明」页叫「说明与指标」，带上节点类型声明的指标与图表（#43）。
 */
export const Inspector = forwardRef<
	HTMLElement,
	{
		/** 画布上选中了什么（只含画布上有的节点）。 */
		selection: CanvasSelection;
		/** 画布上节点的内容。 */
		nodeOf(id: string): DocNode | undefined;
		context: InspectorContext;
		onCollapse(): void;
		/** 在检查器里按 Esc（没有被补全列表等消费）：焦点回到画布。 */
		onEscape(): void;
		/** 打开时场景设置停在哪一页（地址的 `settings`）；没给是「概况」。 */
		initialScenarioTab?: ScenarioTab;
	}
>(function Inspector(
	{ selection, nodeOf, context, onCollapse, onEscape, initialScenarioTab = "overview" },
	ref,
) {
	const width = useInspectorWidth();
	const id = soleNode(selection);
	const node = id === null ? undefined : nodeOf(id);
	const group = multipleNodes(selection);
	const annotationId = selectedAnnotation(selection);
	const annotation = context.doc.annotations.find((a) => a.id === annotationId);
	// 场景设置停在哪一页：选中节点再回来时还是原来的那一页。
	const [scenarioTab, setScenarioTab] = useState<ScenarioTab>(initialScenarioTab);
	return (
		<aside
			ref={ref}
			aria-label="检查器"
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					onEscape();
				}
			}}
			className="absolute top-15.5 right-3 bottom-3.5 z-10 flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface shadow-float"
			style={{ width }}
		>
			{annotation ? (
				<AnnotationInspector
					key={annotation.id}
					annotation={annotation}
					context={context}
					onCollapse={onCollapse}
				/>
			) : id !== null && node ? (
				<NodeInspector key={id} id={id} node={node} context={context} onCollapse={onCollapse} />
			) : group ? (
				<GroupInspector ids={group} context={context} onCollapse={onCollapse} />
			) : (
				<ScenarioInspector
					context={context}
					tab={scenarioTab}
					onTab={setScenarioTab}
					onCollapse={onCollapse}
				/>
			)}
			<InspectorWidthHandle />
		</aside>
	);
});

function WarningList({
	warnings,
	onLocate,
	onLocateAnnotation,
}: {
	warnings: readonly { message: string; node_id?: string; annotation_id?: string }[];
	onLocate?: (id: string) => void;
	/** 注释框的警告（带 `annotation_id`）的「前往」：选中这个注释框。 */
	onLocateAnnotation?: (id: string) => void;
}) {
	return (
		<ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
			{warnings.map((w) => {
				const { annotation_id: annotationId, node_id: nodeId } = w;
				const locate =
					annotationId !== undefined
						? onLocateAnnotation && (() => onLocateAnnotation(annotationId))
						: nodeId !== undefined && onLocate
							? () => onLocate(nodeId)
							: undefined;
				return (
					<li
						key={`${annotationId ?? ""}:${nodeId ?? ""}:${w.message}`}
						className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs text-warn-fg"
					>
						<span className="min-w-0 flex-1">{w.message}</span>
						{locate && (
							<button
								type="button"
								className="flex-none cursor-pointer text-fg-2 underline underline-offset-2 hover:text-fg-1"
								onClick={locate}
							>
								前往
							</button>
						)}
					</li>
				);
			})}
		</ul>
	);
}

type Tab = "params" | "exec" | "doc";

function NodeInspector({
	id,
	node,
	context,
	onCollapse,
}: {
	id: string;
	node: DocNode;
	context: InspectorContext;
	onCollapse(): void;
}) {
	const { doc, catalog, info } = context;
	const request =
		context.focusRequest?.key.startsWith(`${id}/`) === true ? context.focusRequest : null;
	const [tab, setTab] = useState<Tab>(() => (request ? tabOfField(request.key) : "params"));
	useEffect(() => {
		if (!request) return;
		setTab(tabOfField(request.key));
		return focusField(request.key);
	}, [request]);
	const meta = KIND_META[node.kind];
	// 两份节点类型：检查用的（和控制面同一套取法，「没有声明 / 移除」按它）和参数表单用的（开发版本检查跳过时也有字段）。
	const types =
		node.kind === "package" ? inspectorNodeType(doc, node, catalog, context.agents) : undefined;
	const type = types?.form;
	// 引用补全不拦东西：开发版本检查跳过时，用参数表单那份补上，上游节点的输出也列得出来。
	const choices = useMemo(
		() => referenceChoices(doc, id, completionCatalog(doc, catalog, context.agents)),
		[doc, id, catalog, context.agents],
	);
	const warnings = context.warnings.filter((w) => w.node_id === id);
	const fieldErrors = context.shownFieldErrors.filter((e) => e.nodeId === id);
	const problemsOf = (input: string) =>
		warnings.filter((w) => "input" in w && w.input === input).map((w) => w.message);
	// 有对应字段的警告显示在字段下面，其余显示在参数页顶部。
	const fieldInputs = new Set<string>([
		...Object.keys(type?.inputs.properties ?? {}),
		...(node.kind === "async" ? (dispatchTarget(doc, id)?.params.map((p) => p.name) ?? []) : []),
		...(node.kind === "subflow_entry" ? ["name"] : node.kind === "stop_subflow" ? ["subflow"] : []),
	]);
	const general = warnings.filter(
		(w) => !("input" in w && w.input !== undefined && fieldInputs.has(w.input)),
	);
	const change = (next: DocNode) => context.onChangeNode(id, next);
	const displayNameError = fieldErrors.find((e) => e.field === "display_name")?.message;
	const hasExec = node.kind === "package" || node.kind === "stop_subflow";
	const paramErrors = fieldErrors.length;
	const version = node.kind === "package" ? doc.packages[node.package] : undefined;

	return (
		<>
			<Header
				onCollapse={onCollapse}
				title={nodeCardText(node, info).title}
				row={
					<>
						<span className="font-mono text-fg-2">{id}</span>
						<span className="flex min-w-0">
							<span className="truncate">
								· {meta.label}
								{node.kind === "package" && (
									<span className="font-mono">
										{" "}
										· {node.package}/{node.node}
									</span>
								)}
							</span>
							{node.kind === "package" && (
								<span className="flex-none font-mono">@{version ?? "未锁定"}</span>
							)}
						</span>
					</>
				}
				actions={
					node.kind !== "entry" && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="删除节点"
							onClick={() => context.onDelete([id])}
						>
							<Trash2Icon />
						</Button>
					)
				}
			/>
			{!isRemovedDocNode(node) && (
				<FieldList className="flex-none border-b border-border-soft px-3.5 pt-3">
					{isNamedNode(node) && (
						<DisplayNameField
							id={id}
							node={node}
							placeholder={nodeDefaultTitle(node, info)}
							error={displayNameError}
							onChange={change}
						/>
					)}
					<NoteField
						id={id}
						note={node.note}
						error={fieldErrors.find((e) => e.field === "note")?.message}
						onChange={(note) => change({ ...node, note })}
					/>
				</FieldList>
			)}
			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as Tab)}
				className="min-h-0 flex-1 overflow-hidden"
			>
				<TabsList>
					<TabsTrigger value="params">
						{INSPECTOR_PAGE.params}
						{paramErrors > 0 && (
							<span className="font-mono text-2xs text-danger-fg">{paramErrors}</span>
						)}
					</TabsTrigger>
					{hasExec && <TabsTrigger value="exec">{INSPECTOR_PAGE.exec}</TabsTrigger>}
					<TabsTrigger value="doc">
						{node.kind === "package" ? INSPECTOR_PAGE.docWithMetrics : INSPECTOR_PAGE.doc}
					</TabsTrigger>
				</TabsList>
				<TabsContent value="params" className={cn(FIELD_LIST_CLASS, "overflow-auto px-3.5 py-3")}>
					{general.length > 0 && <WarningList warnings={general} />}
					{(node.kind === "entry" || node.kind === "subflow_entry") && (
						<>
							{node.kind === "subflow_entry" && (
								<>
									<SubflowNameField
										id={id}
										node={node}
										problems={problemsOf("name")}
										onChange={change}
									/>
									<SubflowTrigger id={id} doc={doc} onLocate={context.onLocate} />
								</>
							)}
							<SectionTitle>参数</SectionTitle>
							<ParamsEditor
								nodeId={id}
								params={node.params}
								errors={fieldErrors}
								onChange={(params) => change({ ...node, params })}
							/>
						</>
					)}
					{node.kind === "package" && (
						<PackageParams
							id={id}
							node={node}
							type={type}
							undeclared={types?.checked ? undeclaredInputs(types.checked.inputs, node.inputs) : []}
							unchecked={types ? uncheckedInputs(doc, node, types) : []}
							choices={choices}
							problemsOf={problemsOf}
							defaultAgent={doc.default_agent}
							agents={context.agents}
							bots={context.bots}
							onChange={change}
						/>
					)}
					{node.kind === "async" && (
						<AsyncMapping
							id={id}
							node={node}
							doc={doc}
							choices={choices}
							problemsOf={problemsOf}
							onChange={change}
							onLocate={context.onLocate}
						/>
					)}
					{node.kind === "stop_subflow" && (
						<StopSubflowField
							id={id}
							node={node}
							doc={doc}
							problems={problemsOf("subflow")}
							onChange={change}
							onLocate={context.onLocate}
						/>
					)}
					{isRemovedDocNode(node) && <RemovedNodePanel node={node} />}
					{fieldErrors
						.filter(
							(e) =>
								!e.draft &&
								!e.field.startsWith("params.") &&
								e.field !== "display_name" &&
								e.field !== "note",
						)
						.map((e) => (
							<p
								key={e.field}
								data-field-key={fieldErrorKey(e)}
								tabIndex={-1}
								className="m-0 mt-2 text-xs text-danger-fg outline-offset-2"
							>
								{fieldLabel(node, e.field)}：{e.message}
							</p>
						))}
				</TabsContent>
				{hasExec && (
					<TabsContent value="exec" className={cn(FIELD_LIST_CLASS, "overflow-auto px-3.5 py-3")}>
						<ExecutionSettings
							id={id}
							node={node}
							type={type}
							problemsOf={problemsOf}
							onChange={change}
						/>
					</TabsContent>
				)}
				<TabsContent value="doc" className="overflow-auto px-3.5 py-3">
					<NodeDoc id={id} node={node} context={context} />
				</TabsContent>
			</Tabs>
		</>
	);
}

const KIND_DOC: Record<DocNode["kind"], string> = {
	entry: "主链的起点，声明触发运行时填写的入口参数。",
	subflow_entry: "子流程的起点，由异步任务节点调度；只能看到映射传入的参数。",
	async: "派发一个子流程后主链立即继续；子流程失败不影响主链。",
	stop_subflow:
		"停止本链触发的某个子流程，等它完全结束（包括其中的 always 节点）后再继续；由控制面执行，不占用 Agent。",
	// 已移除种类的节点（ADR 0028）。
	...(Object.fromEntries(
		REMOVED_NODE_KIND_NAMES.map((kind) => [kind, "这种节点已不再支持，不能运行，也不能保存。"]),
	) as Record<RemovedNodeKind, string>),
	package: "在 Agent 上执行节点包里的函数。",
};

function NodeDoc({ id, node, context }: { id: string; node: DocNode; context: InspectorContext }) {
	const { doc, catalog } = context;
	const type =
		node.kind === "package"
			? inspectorNodeType(doc, node, catalog, context.agents).form
			: undefined;
	const outputs =
		type && Object.keys(type.outputs.properties).length > 0 ? type.outputs : undefined;
	return (
		<>
			{/* 节点类型的说明是节点函数的文档字符串，按纯文本显示全文，分段规则和「添加节点」菜单一致；没有说明时是通用的那句。 */}
			<div className="mb-3 flex flex-col gap-2 text-xs text-fg-2">
				{descriptionParagraphs(
					(node.kind === "package" && type?.description) || KIND_DOC[node.kind],
				).map((paragraph, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 静态文本，同一段话可能重复，只能按位置区分
					<p key={i} className="m-0">
						{paragraph}
					</p>
				))}
			</div>
			<dl className="m-0 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.75 text-sm">
				<dt className="text-fg-3">节点 ID</dt>
				<dd className="m-0 min-w-0 truncate font-mono">{id}</dd>
				{node.kind === "package" && (
					<>
						<dt className="text-fg-3">节点类型</dt>
						<dd className="m-0 min-w-0 truncate font-mono">
							{node.package}/{node.node}
						</dd>
						<dt className="pt-1.5 text-fg-3">版本</dt>
						<dd className="m-0 min-w-0">
							<PackageVersionField
								name={node.package}
								locked={doc.packages[node.package]}
								packages={context.packages}
								agents={context.agents}
								onLock={context.onLock}
							/>
						</dd>
						{!outputs && (
							<>
								<dt className="text-fg-3">输出</dt>
								<dd className="m-0 min-w-0 font-mono text-xs">{type ? "没有输出" : "—"}</dd>
							</>
						)}
					</>
				)}
			</dl>
			{outputs && <NodeOutputs outputs={outputs} />}
			{node.kind === "package" && (
				<>
					<SectionTitle>声明的指标与图表</SectionTitle>
					<NodeMetrics id={id} type={type} context={context} />
				</>
			)}
		</>
	);
}

/** 包节点的指标与图表，每张图表带「关注」开关（关注项，#344）。 */
function NodeMetrics({
	id,
	type,
	context,
}: {
	id: string;
	type: NodeTypeIo | null | undefined;
	context: InspectorContext;
}) {
	const focus = useFocusItems(context.orchestrationId);
	return (
		<MetricDeclarations
			// 目录里是节点包查询 API 返回的完整节点类型（含默认图表），类型上只声明了输入输出。
			info={type as NodeMetricsInfo | null | undefined}
			focus={{ focus, nodeId: id, saved: isSavedNodeType(context.saved, context.doc, id) }}
		/>
	);
}

/** 选中多个节点时：选了几个，和对这组节点的操作。 */
function GroupInspector({
	ids,
	context,
	onCollapse,
}: {
	ids: readonly string[];
	context: InspectorContext;
	onCollapse(): void;
}) {
	return (
		<>
			<Header onCollapse={onCollapse} title={`已选 ${ids.length} 个节点`} row={<span>多选</span>} />
			<div
				data-focus-start=""
				className={cn(FIELD_LIST_CLASS, "min-h-0 flex-1 overflow-auto px-3.5 py-3")}
			>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={() => context.onAddAnnotation(ids)}>
						<SquareDashedIcon />
						{ACTION.addAnnotation}
					</Button>
					<Button size="sm" onClick={() => context.onDelete(ids)}>
						<Trash2Icon />
						删除选中的节点
					</Button>
				</div>
				<p className="m-0 text-xs text-fg-3">拖动其中任意一个节点，整组一起移动。</p>
			</div>
		</>
	);
}

/** 场景设置的两页：概况和关注项。 */
export const SCENARIO_TABS = ["overview", "focus"] as const;
export type ScenarioTab = (typeof SCENARIO_TABS)[number];

/** 没有选中节点时：场景设置，分两页：概况（默认 Agent、节点包版本、检查结果）和关注项。 */
function ScenarioInspector({
	context,
	tab,
	onTab,
	onCollapse,
}: {
	context: InspectorContext;
	tab: ScenarioTab;
	onTab(tab: ScenarioTab): void;
	onCollapse(): void;
}) {
	return (
		<>
			<Header
				onCollapse={onCollapse}
				title={INSPECTOR_PAGE.sceneSettings}
				row={<span>未选中节点</span>}
			/>
			<Tabs
				value={tab}
				onValueChange={(v) => onTab(v as ScenarioTab)}
				className="min-h-0 flex-1 overflow-hidden"
			>
				<TabsList>
					<TabsTrigger value="overview">{INSPECTOR_PAGE.overview}</TabsTrigger>
					<TabsTrigger value="focus">{INSPECTOR_PAGE.focus}</TabsTrigger>
				</TabsList>
				<TabsContent value="overview" className={cn(FIELD_LIST_CLASS, "overflow-auto px-3.5 py-3")}>
					<ScenarioOverview context={context} />
				</TabsContent>
				<TabsContent value="focus" className="overflow-auto px-3.5 py-3">
					<FocusListPage orchestrationId={context.orchestrationId} saved={context.saved} />
				</TabsContent>
			</Tabs>
		</>
	);
}

/** 场景设置的「概况」页：默认 Agent、节点包版本和检查结果。必须放在 `FIELD_LIST_CLASS` 的容器里。 */
function ScenarioOverview({ context }: { context: InspectorContext }) {
	const { doc, warnings, shownFieldErrors: fieldErrors } = context;
	const summary = checkSummary(fieldErrors.length, warnings.length);
	const used = [
		...new Set(doc.nodes.flatMap((n) => (n.kind === "package" ? [n.package] : []))),
	].sort();
	return (
		<>
			<Field label="默认 Agent" help="未单独选择 Agent 的包节点都派发到这里">
				{(control) => (
					<AgentSelect
						control={control}
						label="默认 Agent"
						value={doc.default_agent}
						agents={context.agents}
						emptyLabel="（未设置）"
						onChange={context.onDefaultAgent}
					/>
				)}
			</Field>
			<SectionTitle>节点包版本</SectionTitle>
			{used.length === 0 && <p className="m-0 text-xs text-fg-3">还没有使用任何节点包。</p>}
			{used.map((name) => (
				<Field key={name} label={name} mono>
					<PackageVersionField
						name={name}
						locked={doc.packages[name]}
						packages={context.packages}
						agents={context.agents}
						onLock={context.onLock}
					/>
				</Field>
			))}
			<SectionTitle aside={<StatusPill kind={summary.kind}>{summary.label}</StatusPill>}>
				检查
			</SectionTitle>
			{fieldErrors.length > 0 && (
				<ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
					{fieldErrors.map((e) => {
						const node = doc.nodes.find((n) => n.id === e.nodeId);
						const annotation = doc.annotations.find((a) => a.id === e.annotationId);
						const { annotationId, nodeId } = e;
						return (
							<li
								key={`${nodeId}:${annotationId}:${e.field}`}
								className={cn(
									"flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-xs text-danger-fg",
								)}
							>
								<span className="min-w-0 flex-1">
									{nodeId && (
										<code className="font-mono">{node ? nodeNameWithId(node) : nodeId}</code>
									)}
									{annotationId && <>注释框 {nameWithId(annotationId, annotation?.title)}</>}{" "}
									{annotationId
										? (ANNOTATION_FIELD_LABEL[e.field] ?? e.field)
										: fieldLabel(node, e.field)}
									：{e.message}
								</span>
								{(nodeId || annotationId) && (
									<button
										type="button"
										className="flex-none cursor-pointer text-fg-2 underline underline-offset-2 hover:text-fg-1"
										onClick={() =>
											annotationId
												? context.onLocateAnnotation(annotationId)
												: context.onLocate(nodeId as string)
										}
									>
										前往
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{warnings.length > 0 ? (
				<WarningList
					warnings={warnings}
					onLocate={context.onLocate}
					onLocateAnnotation={context.onLocateAnnotation}
				/>
			) : (
				<p className="m-0 mb-3 text-xs text-ok">结构、包版本和引用检查都通过了。</p>
			)}
			<p className="m-0 text-xs text-fg-3">
				警告不阻止保存，触发运行时必须全部通过
				{warnings.some(isAnnotationWarning) && "（注释框的警告除外，它不影响运行）"}
				；字段错误（红色）改正后才能保存。
			</p>
		</>
	);
}
