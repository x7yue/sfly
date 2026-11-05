import {
	dispatchTarget,
	nodeTypeOf,
	type OrchestrationWarning,
	type PackageCatalog,
	referenceOptions,
	referenceScope,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { cn } from "cn";
import { PanelRightCloseIcon, Trash2Icon } from "lucide-react";
import { forwardRef, type ReactNode, useMemo, useState } from "react";
import type { DocNode } from "#/canvas/flow";
import type { CanvasInfo } from "#/components/canvas/context";
import { KIND_META, nodeTitle } from "#/components/canvas/node-display";
import { StatusPill } from "#/components/status";
import type { AgentView, PackageSummary } from "#/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FieldError } from "../validation";
import { Field, type ReferenceChoice, SectionTitle } from "./fields";
import {
	AgentSelect,
	AsyncMapping,
	ExecutionSettings,
	PackageParams,
	PackageVersionField,
	SleepForm,
	SubflowTrigger,
	TimerForm,
} from "./node-forms";
import { ParamsEditor } from "./ParamsEditor";

/** 检查器需要的编排级上下文。 */
export interface InspectorContext {
	doc: OrchestrationDocument;
	catalog: PackageCatalog;
	info: CanvasInfo;
	packages: PackageSummary[] | undefined;
	agents: AgentView[];
	warnings: OrchestrationWarning[];
	/** 阻止保存的字段错误（文档校验 + 还没生效的输入）。 */
	fieldErrors: FieldError[];
	onChangeNode(id: string, node: DocNode): void;
	onDefaultAgent(agent: string | undefined): void;
	onLock(name: string, version: string): void;
	/** 选中并定位到另一个节点。 */
	onLocate(id: string): void;
	onDelete(id: string): void;
}

/** 引用补全项的来源说明：参数的类型（敏感参数标出），输出的类型与所属节点。 */
function referenceChoices(doc: OrchestrationDocument, id: string, catalog: PackageCatalog) {
	const scope = referenceScope(doc, id);
	const params = new Map((scope.start?.params ?? []).map((p) => [p.name, p]));
	return referenceOptions(doc, id, catalog).map((o): ReferenceChoice => {
		if (o.kind === "param") {
			const p = params.get(o.key);
			return { ...o, detail: `${p?.type ?? ""}${p?.secret ? " · 敏感" : ""}` };
		}
		const source = doc.nodes.find((n) => n.id === o.node_id);
		const schema =
			source?.kind === "package"
				? nodeTypeOf(doc, source, catalog)?.outputs.properties[o.key]
				: undefined;
		const type = typeof schema?.type === "string" ? `${schema.type} · ` : "";
		return { ...o, detail: `${type}${o.node_id}` };
	});
}

/**
 * 右侧检查器（原型 `.insp`，可收起）。选中节点时：标题区 + 页签（参数 / 执行 / 说明）；
 * 没有选中节点时：场景级设置（默认 Agent、节点包版本、检查结果）。
 * 「说明」页之后由 #43 加上节点类型声明的指标与图表（页签改名为「说明与指标」）。
 */
export const Inspector = forwardRef<
	HTMLElement,
	{
		selected: { id: string; node: DocNode } | null;
		context: InspectorContext;
		onCollapse(): void;
		/** 在检查器里按 Esc（没有被补全列表等消费）：焦点回到画布。 */
		onEscape(): void;
	}
>(function Inspector({ selected, context, onCollapse, onEscape }, ref) {
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
			className="absolute top-15.5 right-3 bottom-3.5 z-10 flex w-93 flex-col overflow-hidden rounded-xl border border-border-soft bg-surface/94 shadow-float outline-none"
		>
			{selected ? (
				<NodeInspector
					key={selected.id}
					id={selected.id}
					node={selected.node}
					context={context}
					onCollapse={onCollapse}
				/>
			) : (
				<ScenarioInspector context={context} onCollapse={onCollapse} />
			)}
		</aside>
	);
});

function Header({
	row,
	title,
	actions,
	onCollapse,
}: {
	row: ReactNode;
	title: string;
	actions?: ReactNode;
	onCollapse(): void;
}) {
	return (
		<div className="flex-none border-b border-border-soft px-3.5 pt-3 pb-2.5">
			<div className="flex items-center gap-1.75 text-xs text-fg-3">
				{row}
				<span className="ml-auto flex items-center">
					{actions}
					<Button variant="ghost" size="icon-sm" aria-label="收起检查器" onClick={onCollapse}>
						<PanelRightCloseIcon />
					</Button>
				</span>
			</div>
			<h2 className="mt-1.5 mb-0.5 truncate text-base font-semibold">{title}</h2>
		</div>
	);
}

function WarningList({
	warnings,
	onLocate,
}: {
	warnings: readonly { message: string; node_id?: string }[];
	onLocate?: (id: string) => void;
}) {
	return (
		<ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
			{warnings.map((w) => (
				<li
					key={`${w.node_id ?? ""}:${w.message}`}
					className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs text-warn-fg"
				>
					<span className="min-w-0 flex-1">{w.message}</span>
					{onLocate && w.node_id && (
						<button
							type="button"
							className="flex-none cursor-pointer text-fg-2 underline underline-offset-2 hover:text-fg-1"
							onClick={() => onLocate(w.node_id as string)}
						>
							前往
						</button>
					)}
				</li>
			))}
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
	const [tab, setTab] = useState<Tab>("params");
	const meta = KIND_META[node.kind];
	const type = node.kind === "package" ? nodeTypeOf(doc, node, catalog) : undefined;
	const choices = useMemo(() => referenceChoices(doc, id, catalog), [doc, id, catalog]);
	const warnings = context.warnings.filter((w) => w.node_id === id);
	const fieldErrors = context.fieldErrors.filter((e) => e.nodeId === id);
	const problemsOf = (input: string) =>
		warnings.filter((w) => "input" in w && w.input === input).map((w) => w.message);
	// 有对应字段的警告显示在字段下面，其余显示在参数页顶部。
	const fieldInputs = new Set<string>([
		...Object.keys(type?.inputs.properties ?? {}),
		...(node.kind === "async" ? (dispatchTarget(doc, id)?.params.map((p) => p.name) ?? []) : []),
		...(node.kind === "timer" ? ["at", "tz"] : node.kind === "sleep" ? ["duration"] : []),
	]);
	const general = warnings.filter(
		(w) => !("input" in w && w.input !== undefined && fieldInputs.has(w.input)),
	);
	const change = (next: DocNode) => context.onChangeNode(id, next);
	const hasExec = node.kind === "package" || node.kind === "timer" || node.kind === "sleep";
	const paramErrors = fieldErrors.length;
	const version = node.kind === "package" ? doc.packages[node.package] : undefined;

	return (
		<>
			<Header
				onCollapse={onCollapse}
				title={nodeTitle(node, info)}
				row={
					<>
						<span className="font-mono text-fg-2">{id}</span>
						<span className="truncate">
							· {meta.label}
							{node.kind === "package" && (
								<span className="font-mono">
									{" "}
									· {node.package}/{node.node}@{version ?? "未锁定"}
								</span>
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
							onClick={() => context.onDelete(id)}
						>
							<Trash2Icon />
						</Button>
					)
				}
			/>
			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as Tab)}
				className="min-h-0 flex-1 overflow-hidden"
			>
				<TabsList>
					<TabsTrigger value="params">
						参数
						{paramErrors > 0 && (
							<span className="font-mono text-2xs text-danger-fg">{paramErrors}</span>
						)}
					</TabsTrigger>
					{hasExec && <TabsTrigger value="exec">执行</TabsTrigger>}
					<TabsTrigger value="doc">说明</TabsTrigger>
				</TabsList>
				<TabsContent value="params" className="overflow-auto px-3.5 py-3">
					{general.length > 0 && <WarningList warnings={general} />}
					{(node.kind === "entry" || node.kind === "subflow_entry") && (
						<>
							{node.kind === "subflow_entry" && (
								<SubflowTrigger id={id} doc={doc} onLocate={context.onLocate} />
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
							choices={choices}
							problemsOf={problemsOf}
							defaultAgent={doc.default_agent}
							agents={context.agents}
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
					{node.kind === "timer" && (
						<TimerForm node={node} problemsOf={problemsOf} onChange={change} />
					)}
					{node.kind === "sleep" && (
						<SleepForm node={node} choices={choices} problemsOf={problemsOf} onChange={change} />
					)}
					{fieldErrors
						.filter((e) => !e.draft && !e.field.startsWith("params."))
						.map((e) => (
							<p key={e.field} className="m-0 mt-2 text-2xs text-danger-fg">
								{e.field}：{e.message}
							</p>
						))}
				</TabsContent>
				{hasExec && (
					<TabsContent value="exec" className="overflow-auto px-3.5 py-3">
						<ExecutionSettings id={id} node={node} onChange={change} />
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
	timer: "等到某个时刻再继续，由控制面执行，不占用 Agent。",
	sleep: "等待一段时长再继续，由控制面执行，不占用 Agent。",
	package: "在 Agent 上执行节点包里的函数。",
};

function NodeDoc({ id, node, context }: { id: string; node: DocNode; context: InspectorContext }) {
	const { doc, catalog } = context;
	const type = node.kind === "package" ? nodeTypeOf(doc, node, catalog) : undefined;
	const outputs = type ? Object.keys(type.outputs.properties) : undefined;
	return (
		<>
			<p className="m-0 mb-3 text-xs text-fg-2">{KIND_DOC[node.kind]}</p>
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
						<dt className="text-fg-3">输出</dt>
						<dd className="m-0 min-w-0 font-mono text-xs">
							{outputs === undefined
								? "—"
								: outputs.length === 0
									? "没有输出"
									: outputs.join(" · ")}
						</dd>
					</>
				)}
			</dl>
		</>
	);
}

/** 没有选中节点时：场景级设置与检查结果。 */
function ScenarioInspector({
	context,
	onCollapse,
}: {
	context: InspectorContext;
	onCollapse(): void;
}) {
	const { doc, warnings, fieldErrors } = context;
	const used = [
		...new Set(doc.nodes.flatMap((n) => (n.kind === "package" ? [n.package] : []))),
	].sort();
	return (
		<>
			<Header onCollapse={onCollapse} title="场景设置" row={<span>未选中节点</span>} />
			<div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
				<Field label="默认 Agent" help="未单独选择 Agent 的包节点都派发到这里">
					<AgentSelect
						label="默认 Agent"
						value={doc.default_agent}
						agents={context.agents}
						emptyLabel="（未设置）"
						onChange={context.onDefaultAgent}
					/>
				</Field>
				<SectionTitle>节点包版本</SectionTitle>
				{used.length === 0 && <p className="m-0 text-xs text-fg-3">还没有使用任何节点包。</p>}
				{used.map((name) => (
					<Field key={name} label={<span className="font-mono">{name}</span>}>
						<PackageVersionField
							name={name}
							locked={doc.packages[name]}
							packages={context.packages}
							agents={context.agents}
							onLock={context.onLock}
						/>
					</Field>
				))}
				<SectionTitle
					aside={
						<StatusPill kind={warnings.length > 0 ? "warn" : "ok"}>
							{warnings.length > 0 ? `${warnings.length} 条警告` : "检查通过"}
						</StatusPill>
					}
				>
					检查
				</SectionTitle>
				{fieldErrors.length > 0 && (
					<ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
						{fieldErrors.map((e) => (
							<li
								key={`${e.nodeId}:${e.field}`}
								className={cn(
									"flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-xs text-danger-fg",
								)}
							>
								<span className="min-w-0 flex-1">
									{e.nodeId && <code className="font-mono">{e.nodeId}</code>} {e.message}
								</span>
								{e.nodeId && (
									<button
										type="button"
										className="flex-none cursor-pointer text-fg-2 underline underline-offset-2 hover:text-fg-1"
										onClick={() => context.onLocate(e.nodeId as string)}
									>
										前往
									</button>
								)}
							</li>
						))}
					</ul>
				)}
				{warnings.length > 0 ? (
					<WarningList warnings={warnings} onLocate={context.onLocate} />
				) : (
					<p className="m-0 text-xs text-ok">结构、包版本和引用检查都通过了。</p>
				)}
				<p className="m-0 text-2xs text-fg-3">
					警告不阻止保存，触发运行时必须全部通过；字段错误（红色）改正后才能保存。
				</p>
			</div>
		</>
	);
}
