// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	nodeTypeOf,
	type OrchestrationWarning,
	type PackageCatalog,
	referenceOptions,
} from "@sfly/orchestration";
import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import { useState } from "react";
import type { AgentView, PackageSummary } from "#/lib/api";
import type { DocNode } from "./flow";
import { InputsForm } from "./InputsForm";
import { KIND_LABEL, KindChip } from "./NodeCard";
import { AlwaysToggle, ExecutionSettings } from "./NodeSettings";
import { PackageVersionRow } from "./PackageVersions";

type Param = Extract<OrchestrationNode, { kind: "entry" }>["params"][number];
type ParamType = Param["type"];

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const inputClass = "sf-inp";

export function Section({
	title,
	aside,
	children,
}: {
	title: string;
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="sf-sec">
			<h3>
				{title}
				{aside !== undefined && <span className="sf-r">{aside}</span>}
			</h3>
			{children}
		</section>
	);
}

/** Agent 选择：列出已注册的 Agent 及在线状态；文档里引用了未注册的 Agent 时也保留这个选项。 */
export function AgentSelect({
	value,
	agents,
	emptyLabel,
	onChange,
	label,
}: {
	value: string | undefined;
	agents: AgentView[];
	emptyLabel: string;
	onChange(value: string | undefined): void;
	label: string;
}) {
	const names = agents.map((a) => a.name);
	return (
		<select
			aria-label={label}
			className={inputClass}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			<option value="">{emptyLabel}</option>
			{agents.map((a) => (
				<option key={a.name} value={a.name}>
					{a.name}（{a.status === "online" ? "在线" : "离线"}）
				</option>
			))}
			{value && !names.includes(value) && <option value={value}>{value}（未注册）</option>}
		</select>
	);
}

export function WarningList({ warnings }: { warnings: OrchestrationWarning[] }) {
	if (warnings.length === 0) {
		return <p className="text-[12.5px] text-[var(--sf-ok)]">结构、包版本和引用检查都通过了。</p>;
	}
	return (
		<ul className="space-y-1">
			{warnings.map((w) => (
				<li key={`${w.code}:${w.node_id ?? ""}:${w.message}`} className="sf-warn-item">
					{w.message}
				</li>
			))}
		</ul>
	);
}

/** 入口节点的参数声明：名称、类型、默认值、是否必填、是否敏感。 */
export function ParamsEditor({
	params,
	onChange,
}: {
	params: Param[];
	onChange(params: Param[]): void;
}) {
	const update = (index: number, patch: Partial<Param>) =>
		onChange(params.map((p, i) => (i === index ? { ...p, ...patch } : p)));
	const names = params.map((p) => p.name);

	return (
		<div className="space-y-3">
			{params.length === 0 && <p className="sf-hint">还没有参数。</p>}
			{params.map((param, index) => {
				const nameError = !PARAM_NAME.test(param.name)
					? "名称只能包含字母、数字和下划线，不能以数字开头"
					: names.indexOf(param.name) !== index
						? "参数名重复"
						: null;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: 参数名可以编辑，没有稳定的键
					<div key={index} className="sf-card space-y-2">
						<div className="flex gap-2">
							<input
								aria-label="参数名称"
								className={`${inputClass} sf-inp--mono`}
								value={param.name}
								placeholder="名称"
								onChange={(e) => update(index, { name: e.target.value })}
							/>
							<select
								aria-label="参数类型"
								className={`${inputClass} w-28 shrink-0`}
								value={param.type}
								onChange={(e) =>
									update(index, { type: e.target.value as ParamType, default: undefined })
								}
							>
								<option value="string">string</option>
								<option value="number">number</option>
								<option value="boolean">boolean</option>
								<option value="json">json</option>
							</select>
						</div>
						{nameError && <p className="sf-err">{nameError}</p>}
						<DefaultInput
							type={param.type}
							value={param.default}
							onChange={(value) => update(index, { default: value })}
						/>
						<div className="flex items-center gap-4 text-[12.5px] text-[var(--sf-text-2)]">
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={param.required}
									onChange={(e) => update(index, { required: e.target.checked })}
								/>
								必填
							</label>
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={param.secret}
									onChange={(e) => update(index, { secret: e.target.checked })}
								/>
								敏感
							</label>
							<button
								type="button"
								className="sf-link sf-link--danger ml-auto text-xs"
								onClick={() => onChange(params.filter((_, i) => i !== index))}
							>
								删除
							</button>
						</div>
					</div>
				);
			})}
			<button
				type="button"
				className="sf-addrow"
				onClick={() =>
					onChange([
						...params,
						{
							name: uniqueParamName(names),
							type: "string",
							required: false,
							secret: false,
						},
					])
				}
			>
				+ 添加参数
			</button>
		</div>
	);
}

function uniqueParamName(names: string[]): string {
	for (let i = 1; ; i++) {
		const name = `param_${i}`;
		if (!names.includes(name)) return name;
	}
}

/** 默认值输入：按参数类型给出不同的控件；留空表示没有默认值。 */
function DefaultInput({
	type,
	value,
	onChange,
}: {
	type: ParamType;
	value: unknown;
	onChange(value: unknown): void;
}) {
	const [jsonText, setJsonText] = useState(() =>
		value === undefined ? "" : JSON.stringify(value, null, 2),
	);
	const [jsonError, setJsonError] = useState<string | null>(null);

	switch (type) {
		case "string":
			return (
				<input
					aria-label="默认值"
					className={inputClass}
					placeholder="默认值（可选）"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
				/>
			);
		case "number":
			return (
				<input
					aria-label="默认值"
					type="number"
					className={inputClass}
					placeholder="默认值（可选）"
					value={typeof value === "number" ? value : ""}
					onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
				/>
			);
		case "boolean":
			return (
				<select
					aria-label="默认值"
					className={inputClass}
					value={value === undefined ? "" : String(value)}
					onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
				>
					<option value="">无默认值</option>
					<option value="true">true</option>
					<option value="false">false</option>
				</select>
			);
		case "json":
			return (
				<div>
					<textarea
						aria-label="默认值"
						className={`${inputClass} sf-inp--mono`}
						placeholder="默认值（JSON，可选）"
						value={jsonText}
						onChange={(e) => {
							setJsonText(e.target.value);
							if (e.target.value.trim() === "") {
								setJsonError(null);
								onChange(undefined);
								return;
							}
							try {
								onChange(JSON.parse(e.target.value));
								setJsonError(null);
							} catch {
								setJsonError("不是合法的 JSON");
							}
						}}
					/>
					{jsonError && <p className="sf-err">{jsonError}</p>}
				</div>
			);
	}
}

/** 选中节点时的详情。 */
export function NodeInspector({
	node,
	id,
	title,
	doc,
	catalog,
	packages,
	defaultAgent,
	agents,
	warnings,
	onChange,
	onLock,
	onDelete,
}: {
	node: DocNode;
	id: string;
	title: string;
	/** 当前画布内容（用于引用补全和查找节点类型）。 */
	doc: OrchestrationDocument;
	catalog: PackageCatalog;
	packages: PackageSummary[] | undefined;
	defaultAgent: string | undefined;
	agents: AgentView[];
	warnings: OrchestrationWarning[];
	onChange(node: DocNode): void;
	/** 把某个节点包锁定（升级）到指定版本。 */
	onLock(name: string, version: string): void;
	onDelete?: () => void;
}) {
	const type = node.kind === "package" ? nodeTypeOf(doc, node, catalog) : undefined;
	// 包节点表单里有对应字段的输入警告显示在字段下面，其余显示在警告区。
	const general = warnings.filter(
		(w) => !("input" in w && w.input !== undefined && type?.inputs.properties[w.input]),
	);
	return (
		<>
			<section className="sf-sec sf-ins-head">
				<div className="flex items-center gap-2.5">
					<KindChip kind={node.kind} />
					<div className="min-w-0">
						<div className="flex gap-2 text-xs text-[var(--sf-text-3)]">
							<code className="text-[var(--sf-text-2)]">{id}</code>
							<span>{KIND_LABEL[node.kind]}</span>
						</div>
						<h2 className="truncate">{title}</h2>
					</div>
				</div>
				{node.kind === "package" && (
					<div className="mt-3">
						<p className="mb-1 font-mono text-xs text-[var(--sf-text-3)]">
							{node.package}/{node.node}
						</p>
						<PackageVersionRow
							name={node.package}
							locked={doc.packages[node.package]}
							packages={packages}
							agents={agents}
							nodeAgent={node.agent ?? defaultAgent}
							onLock={onLock}
						/>
					</div>
				)}
			</section>
			{general.length > 0 && (
				<Section title="警告" aside={`${general.length} 条`}>
					<WarningList warnings={general} />
				</Section>
			)}
			{(node.kind === "entry" || node.kind === "subflow_entry") && (
				<Section title="参数">
					<ParamsEditor params={node.params} onChange={(params) => onChange({ ...node, params })} />
				</Section>
			)}
			{node.kind === "package" && (
				<>
					<Section title="输入" aside="常量或引用">
						<InputsForm
							type={type}
							inputs={node.inputs}
							options={referenceOptions(doc, id, catalog)}
							warnings={warnings}
							onChange={(inputs) => onChange({ ...node, inputs })}
						/>
						<p className="sf-hint">
							输入 <code>{"${{"}</code> 或点 <code>{"${}"}</code>{" "}
							插入引用：只能引用本链的入口参数和本链上前面节点的输出。
						</p>
					</Section>
					<Section title="Agent">
						<AgentSelect
							label="节点 Agent"
							value={node.agent}
							agents={agents}
							emptyLabel={`使用默认 Agent（${defaultAgent ?? "未设置"}）`}
							onChange={(agent) => {
								const { agent: _old, ...rest } = node;
								onChange(agent ? { ...rest, agent } : rest);
							}}
						/>
					</Section>
					<Section title="执行">
						<ExecutionSettings node={node} onChange={onChange} />
						<AlwaysToggle node={node} onChange={onChange} />
					</Section>
				</>
			)}
			{(node.kind === "timer" || node.kind === "sleep") && (
				<Section title="执行">
					<AlwaysToggle node={node} onChange={onChange} />
				</Section>
			)}
			{onDelete && (
				<Section title="操作">
					<button type="button" className="sf-btn sf-btn--ghost sf-btn--sm" onClick={onDelete}>
						删除节点
					</button>
				</Section>
			)}
		</>
	);
}
