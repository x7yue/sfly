// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	dispatchTarget,
	NODE_DEFAULTS,
	type NodeTypeIo,
	orderedInputs,
	schemaDescription,
	stopCandidates,
} from "@sfly/orchestration";
import type {
	AgentView,
	FeishuBotView,
	PackageSummary,
	StoredOrchestrationDocument,
} from "@sfly/schema";
import { useRef } from "react";
import type { DocNode } from "#/components/canvas/flow";
import { MESSAGE, subflowLabel } from "#/lib/copy";
import { latestVersion } from "#/lib/package-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { agentsWithDev } from "../catalog";
import { draftKey, useFieldErrors, useParsedField } from "../field-drafts";
import { AgentSelect } from "./AgentSelect";
import { Field, SectionTitle } from "./fields";
import {
	InsertReferenceGlyph,
	ReferenceEditor,
	type ReferenceEditorHandle,
} from "./ReferenceEditor";
import type { ReferenceChoice } from "./reference-completion";
import { timeoutHelp, timeoutPlaceholder } from "./timeout-note";
import { Problems, ValueField } from "./value-fields";
import { mappedText, mappedValue } from "./value-text";
import { ReferenceActions } from "./ZoomEditor";

type PackageNode = Extract<DocNode, { kind: "package" }>;
type AsyncNode = Extract<DocNode, { kind: "async" }>;
type StopSubflowNode = Extract<DocNode, { kind: "stop_subflow" }>;
type AlwaysNode = PackageNode | StopSubflowNode;

/** 某个字段的静态检查警告（不阻止保存）。 */
export type ProblemsOf = (input: string) => string[];

/** 开发版本的版本号（`包名@dev`）。 */
const DEV_VERSION = "dev";

/** 包节点的「参数」页：按输入 schema 生成的表单，以及节点的 Agent。 */
export function PackageParams({
	id,
	node,
	type,
	choices,
	problemsOf,
	defaultAgent,
	agents,
	bots,
	onChange,
}: {
	id: string;
	node: PackageNode;
	/** null：找不到节点类型；undefined：还在加载。 */
	type: NodeTypeIo | null | undefined;
	choices: ReferenceChoice[];
	problemsOf: ProblemsOf;
	defaultAgent: string | undefined;
	agents: AgentView[];
	bots: readonly FeishuBotView[];
	onChange(node: PackageNode): void;
}) {
	const set = (name: string, value: unknown) => {
		const { [name]: _old, ...rest } = node.inputs;
		onChange({ ...node, inputs: value === undefined ? rest : { ...rest, [name]: value } });
	};
	const properties = type ? orderedInputs(type.inputs) : [];
	const required = new Set(type?.inputs.required ?? []);
	const undeclared = Object.keys(node.inputs).filter((k) => !type?.inputs.properties[k]);
	return (
		<>
			{type === undefined && <p className="m-0 text-xs text-fg-3">{MESSAGE.loading}</p>}
			{type === null && (
				<p className="m-0 mb-3 text-xs text-warn-fg">
					找不到这个节点类型的元信息，不能生成参数表单。
				</p>
			)}
			{type && properties.length === 0 && (
				<p className="m-0 mb-3 text-xs text-fg-3">这个节点类型没有输入。</p>
			)}
			{properties.map(([name, schema]) => (
				<ValueField
					key={name}
					nodeId={id}
					name={name}
					schema={schema}
					required={required.has(name)}
					value={node.inputs[name]}
					choices={choices}
					agents={agents}
					bots={bots}
					problems={problemsOf(name)}
					help={schemaDescription(schema)}
					onChange={(v) => set(name, v)}
				/>
			))}
			{undeclared.map((name) => (
				<div key={name} className="mb-3 flex items-center gap-2 text-xs text-warn-fg">
					<span className="min-w-0 flex-1">
						输入 <code className="font-mono">{name}</code> 没有在节点类型中声明
					</span>
					<Button size="sm" variant="ghost" onClick={() => set(name, undefined)}>
						移除
					</Button>
				</div>
			))}
			<p className="m-0 text-xs text-fg-3">
				引用在派发时解析；整值引用保持原类型。字符串里输入 <code>$</code> 或点{" "}
				<InsertReferenceGlyph /> 可以把引用和文字混写。
			</p>
			<SectionTitle>派发</SectionTitle>
			<Field label="Agent">
				{(control) => (
					<AgentSelect
						control={control}
						label="节点 Agent"
						value={node.agent}
						agents={agents}
						emptyLabel={`跟随默认（${defaultAgent ?? "未设置"}）`}
						onChange={(agent) => {
							const { agent: _old, ...rest } = node;
							onChange(agent ? { ...rest, agent } : rest);
						}}
					/>
				)}
			</Field>
		</>
	);
}

const SETTINGS = [
	{
		key: "timeout",
		label: "超时",
		min: 1,
		placeholder: `${NODE_DEFAULTS.timeout}（默认，秒）`,
		help: "从任务开始运行时计时",
	},
	{
		key: "retries",
		label: "重试次数",
		min: 0,
		placeholder: `${NODE_DEFAULTS.retries}（默认）`,
		help: "只对 node_error / timeout / agent_lost 重试",
	},
	{
		key: "queue_timeout",
		label: "排队超时",
		min: 1,
		placeholder: `${NODE_DEFAULTS.queue_timeout}（默认，秒）`,
		help: "等待 Agent 空闲槽位的最长时间",
	},
] as const;

/** 执行设置：超时、重试次数、排队超时（包节点），always（包节点、停止子流程）。 */
export function ExecutionSettings({
	id,
	node,
	type,
	onChange,
}: {
	id: string;
	node: AlwaysNode;
	/** 包节点的节点类型（超时没填时写它声明的）；null：找不到；undefined：还在加载。 */
	type?: NodeTypeIo | null | undefined;
	onChange(node: AlwaysNode): void;
}) {
	return (
		<>
			{node.kind === "package" &&
				SETTINGS.map((s) => (
					<SettingField
						key={s.key}
						fieldKey={draftKey(id, s.key)}
						setting={
							s.key === "timeout"
								? { ...s, placeholder: timeoutPlaceholder(type), help: timeoutHelp(node, type) }
								: s
						}
						value={node[s.key]}
						onChange={(value) => {
							const { [s.key]: _old, ...rest } = node;
							onChange(value === undefined ? rest : { ...rest, [s.key]: value });
						}}
					/>
				))}
			<Field label="always">
				{(control) => (
					<div className="flex h-7.5 items-center">
						<Switch
							id={control.id}
							aria-labelledby={`${control.id}-label`}
							aria-describedby={`${control.id}-help`}
							label={
								<span id={`${control.id}-help`} className="text-xs text-fg-3">
									前面失败或运行被取消时仍执行
								</span>
							}
							checked={node.always}
							onCheckedChange={(always) => onChange({ ...node, always })}
						/>
					</div>
				)}
			</Field>
			{node.kind !== "package" && (
				<p className="m-0 text-xs text-fg-3">由控制面执行，不占用 Agent 槽位。</p>
			)}
		</>
	);
}

function SettingField({
	fieldKey,
	setting,
	value,
	onChange,
}: {
	fieldKey: string;
	setting: { label: string; min: number; placeholder: string; help: string };
	value: number | undefined;
	onChange(value: number | undefined): void;
}) {
	const field = useParsedField<number | undefined>({
		key: fieldKey,
		value,
		format: (v) => (v === undefined ? "" : String(v)),
		parse: (raw) => {
			if (raw.trim() === "") return { value: undefined };
			const n = Number(raw);
			if (!Number.isInteger(n) || n < setting.min) {
				return { error: setting.min > 0 ? "需要正整数" : "需要非负整数" };
			}
			return { value: n };
		},
		onChange,
	});
	return (
		<Field label={setting.label} fieldKey={fieldKey} error={field.error} help={setting.help}>
			{(control) => (
				<Input
					{...control}
					inputMode="numeric"
					className="font-mono text-xs"
					placeholder={setting.placeholder}
					value={field.text}
					onChange={(e) => field.change(e.target.value)}
				/>
			)}
		</Field>
	);
}

/** 异步任务节点：调度到的子流程，以及把主链的值映射为子流程参数（按值传入）。 */
export function AsyncMapping({
	id,
	node,
	doc,
	choices,
	problemsOf,
	onChange,
	onLocate,
}: {
	id: string;
	node: AsyncNode;
	doc: StoredOrchestrationDocument;
	choices: ReferenceChoice[];
	problemsOf: ProblemsOf;
	onChange(node: AsyncNode): void;
	onLocate(id: string): void;
}) {
	const subflow = dispatchTarget(doc, id);
	const setParam = (name: string, value: unknown) => {
		const params = { ...node.params };
		if (value === undefined) delete params[name];
		else params[name] = value;
		onChange({ ...node, params });
	};
	if (!subflow) {
		return (
			<p className="m-0 text-xs text-fg-3">
				从节点底部的 ◆ 调度端口拖一条连线到某个子流程入口节点，再在这里映射子流程参数。
			</p>
		);
	}
	const declared = new Set(subflow.params.map((p) => p.name));
	const extra = Object.keys(node.params).filter((k) => !declared.has(k));
	return (
		<>
			<Field label="调度到">
				<div className="flex h-7.5 items-center gap-2">
					<Badge>◆ {subflowLabel(subflow)}</Badge>
					{subflowLabel(subflow) !== subflow.id && (
						<span className="font-mono text-2xs text-fg-3">{subflow.id}</span>
					)}
					<Button size="sm" variant="ghost" onClick={() => onLocate(subflow.id)}>
						定位
					</Button>
				</div>
			</Field>
			<SectionTitle>参数映射（按值传入）</SectionTitle>
			{subflow.params.length === 0 && (
				<p className="m-0 text-xs text-fg-3">子流程入口 {subflow.id} 没有声明参数。</p>
			)}
			{subflow.params.map((p) => (
				<MappedParam
					key={p.name}
					fieldKey={draftKey(id, `mapping.${p.name}`)}
					param={p}
					value={node.params[p.name]}
					choices={choices}
					problems={problemsOf(p.name)}
					onChange={(value) => setParam(p.name, value)}
				/>
			))}
			{extra.map((name) => (
				<div key={name} className="mb-3 flex items-center gap-2 text-xs text-warn-fg">
					<span className="min-w-0 flex-1">
						映射了子流程没有声明的参数 <code className="font-mono">{name}</code>
					</span>
					<Button size="sm" variant="ghost" onClick={() => setParam(name, undefined)}>
						移除
					</Button>
				</div>
			))}
			<p className="m-0 text-xs text-fg-3">
				子流程只能看到这里传入的参数；可以写常量，或输入 <code>$</code>{" "}
				引用本链的入口参数和前序节点的输出。
			</p>
		</>
	);
}

type SubflowEntryNode = Extract<DocNode, { kind: "subflow_entry" }>;
type SubflowParam = SubflowEntryNode["params"][number];

/**
 * 一个子流程参数的映射：与包节点的字符串输入同一个输入框，文字和引用混写。
 * 目标参数不是 string 时，不含引用的 JSON 字面量按常量保存（value-text 的 mappedValue）；清空就是不映射。
 */
function MappedParam({
	fieldKey,
	param,
	value,
	choices,
	problems,
	onChange,
}: {
	fieldKey: string;
	param: SubflowParam;
	value: unknown;
	choices: ReferenceChoice[];
	problems: string[];
	onChange(value: unknown): void;
}) {
	const editor = useRef<ReferenceEditorHandle>(null);
	// 输入框里保留用户写的文本：1.0 保存为数字 1，但不把正在输入的文本改写掉。
	const field = useParsedField<unknown>({
		key: fieldKey,
		value,
		format: mappedText,
		parse: (text) => ({ value: mappedValue(text, param.type) }),
		onChange,
	});
	const label = `子流程参数 ${param.name}`;
	const placeholder =
		param.default !== undefined ? `默认 ${mappedText(param.default)}` : param.type;
	const errors = useFieldErrors(fieldKey, problems);
	const invalid = errors.length > 0;
	return (
		<Field
			label={param.name}
			mono
			fieldKey={fieldKey}
			required={param.required}
			type={param.type}
			help={param.description}
			error={invalid ? <Problems problems={errors} /> : undefined}
			aside={
				<ReferenceActions
					editor={editor}
					zoom={param.type === "string" || param.type === "json"}
					name={param.name}
					label={label}
					value={field.text}
					choices={choices}
					placeholder={placeholder}
					invalid={invalid}
					error={invalid ? <Problems problems={errors} /> : undefined}
					onChange={field.change}
				/>
			}
		>
			{(control) => (
				<ReferenceEditor
					ref={editor}
					control={control}
					label={label}
					value={field.text}
					choices={choices}
					placeholder={placeholder}
					onChange={field.change}
				/>
			)}
		</Field>
	);
}

/**
 * 子流程入口节点的名称（场景内唯一，停止子流程节点按名称选择子流程）。
 * 没有名称字段的旧版本显示节点 ID；名称为空或重复的警告显示在字段下面。
 */
export function SubflowNameField({
	id,
	node,
	problems,
	onChange,
}: {
	id: string;
	node: SubflowEntryNode;
	problems: string[];
	onChange(node: SubflowEntryNode): void;
}) {
	return (
		<Field
			label="子流程名称"
			required
			error={problems.length > 0 ? problems.join("；") : undefined}
			help="场景内唯一；停止子流程节点按名称选择子流程，改名不影响引用"
		>
			{(control) => (
				<Input
					{...control}
					value={node.name ?? id}
					onChange={(e) => onChange({ ...node, name: e.target.value })}
				/>
			)}
		</Field>
	);
}

/**
 * 停止子流程节点：按名称选择要停止的子流程（docs/SEMANTICS.md §4.1）。只列出合法候选——本链在它之前触发的子流程及其下级子流程；
 * 已选的子流程不再合法（例如顺序变了）时仍显示在列表里，警告显示在字段下面。
 */
export function StopSubflowField({
	id,
	node,
	doc,
	problems,
	onChange,
	onLocate,
}: {
	id: string;
	node: StopSubflowNode;
	doc: StoredOrchestrationDocument;
	problems: string[];
	onChange(node: StopSubflowNode): void;
	onLocate(id: string): void;
}) {
	const entries = new Map(
		doc.nodes.flatMap((n) => (n.kind === "subflow_entry" ? [[n.id, n] as const] : [])),
	);
	const candidates = stopCandidates(doc, id).flatMap((c) => {
		const entry = entries.get(c);
		return entry ? [entry] : [];
	});
	const current = node.subflow;
	const stale = current !== undefined && !candidates.some((c) => c.id === current);
	const label = (subflowId: string) => {
		const entry = entries.get(subflowId);
		return entry ? subflowLabel(entry) : subflowId;
	};
	return (
		<>
			<Field
				label="要停止的子流程"
				required
				error={problems.length > 0 ? problems.join("；") : undefined}
				help="只列出本链在这个节点之前触发的子流程（含它们触发的子流程）；改名不影响引用"
			>
				{(control) => (
					<div className="flex items-center gap-2">
						<NativeSelect
							{...control}
							className="min-w-0 flex-1"
							value={current ?? ""}
							onChange={(e) => {
								const { subflow: _old, ...rest } = node;
								onChange(e.target.value === "" ? rest : { ...rest, subflow: e.target.value });
							}}
						>
							<NativeSelectOption value="">
								{candidates.length === 0 ? "本链在这里之前没有触发子流程" : "选择子流程"}
							</NativeSelectOption>
							{candidates.map((c) => (
								<NativeSelectOption key={c.id} value={c.id}>
									{subflowLabel(c)}
								</NativeSelectOption>
							))}
							{stale && (
								<NativeSelectOption value={current}>
									{label(current)}（不能停止）
								</NativeSelectOption>
							)}
						</NativeSelect>
						{current !== undefined && entries.has(current) && (
							<Button size="sm" variant="ghost" onClick={() => onLocate(current)}>
								定位
							</Button>
						)}
					</div>
				)}
			</Field>
			<p className="m-0 text-xs text-fg-3">
				运行到这里时停止这个子流程：任务按取消的方式终止，未开始的节点记为已停止，always
				节点照常执行； 子流程完全结束后本节点才成功，输出子流程的结果 <code>status</code>。
			</p>
		</>
	);
}

/** 子流程入口节点：触发它的异步任务节点。 */
export function SubflowTrigger({
	id,
	doc,
	onLocate,
}: {
	id: string;
	doc: StoredOrchestrationDocument;
	onLocate(id: string): void;
}) {
	const triggers = doc.edges.filter((e) => e.kind === "dispatch" && e.to === id).map((e) => e.from);
	return (
		<Field label="触发">
			<div className="flex min-h-7.5 flex-wrap items-center gap-2 text-xs text-fg-2">
				{triggers.length === 0
					? "还没有异步任务节点调度这个子流程"
					: triggers.map((t) => (
							<span key={t} className="flex items-center gap-1">
								由 <code className="font-mono text-fg-1">{t}</code> 调度
								<Button size="sm" variant="ghost" onClick={() => onLocate(t)}>
									定位
								</Button>
							</span>
						))}
			</div>
		</Field>
	);
}

/** 节点包的版本锁定：任一已发布版本或 dev；有更新的版本时可以一键升级。同一个包的所有节点一起改。 */
export function PackageVersionField({
	name,
	locked,
	packages,
	agents,
	onLock,
}: {
	name: string;
	locked: string | undefined;
	packages: PackageSummary[] | undefined;
	agents: AgentView[];
	onLock(name: string, version: string): void;
}) {
	const latest = latestVersion(packages, name);
	const published = packages?.find((p) => p.name === name)?.versions.map((v) => v.version) ?? [];
	const devAgents = agentsWithDev(agents, name).map((a) => a.name);
	const isDev = locked === DEV_VERSION;
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<NativeSelect
				aria-label={`${name} 的版本`}
				className="w-36 flex-none [&_select]:font-mono [&_select]:text-xs"
				value={locked ?? ""}
				onChange={(e) => e.target.value && onLock(name, e.target.value)}
			>
				{locked === undefined && <NativeSelectOption value="">未锁定</NativeSelectOption>}
				{published.map((v) => (
					<NativeSelectOption key={v} value={v}>
						{v}
						{v === latest ? "（最新）" : ""}
					</NativeSelectOption>
				))}
				{locked !== undefined && !isDev && !published.includes(locked) && (
					<NativeSelectOption value={locked}>{locked}（未发布）</NativeSelectOption>
				)}
				{(devAgents.length > 0 || isDev) && (
					<NativeSelectOption value={DEV_VERSION}>dev（开发版本）</NativeSelectOption>
				)}
			</NativeSelect>
			{latest && latest !== locked && (
				<Button size="sm" variant="ghost" onClick={() => onLock(name, latest)}>
					{locked && !isDev ? `升级到 ${latest}` : `锁定到 ${latest}`}
				</Button>
			)}
		</div>
	);
}
