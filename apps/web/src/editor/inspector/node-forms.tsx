// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	dispatchTarget,
	FEISHU_BODY_LIMIT_LABEL,
	FEISHU_MSG_TYPES,
	isTimeZone,
	NODE_DEFAULTS,
	type NodeTypeIo,
	orderedInputs,
	parseDuration,
	referencesIn,
	stopCandidates,
	timerTarget,
} from "@sfly/orchestration";
import {
	type AgentView,
	type FeishuBotView,
	FeishuCardColor,
	type OrchestrationDocument,
	type PackageSummary,
} from "@sfly/schema";
import { useId, useRef } from "react";
import type { DocNode } from "#/components/canvas/flow";
import { controlPlaneNow } from "#/lib/control-plane-time";
import { ACTION, subflowLabel } from "#/lib/copy";
import { latestVersion } from "#/lib/package-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { agentsWithDev } from "../catalog";
import { draftKey, useParsedField } from "../field-drafts";
import { AgentSelect } from "./AgentSelect";
import { FeishuBotSelect } from "./FeishuBotSelect";
import { Field, SectionTitle } from "./fields";
import {
	InsertReferenceButton,
	ReferenceEditor,
	type ReferenceEditorHandle,
} from "./ReferenceEditor";
import { ReferenceChip, ReferencePicker } from "./ReferencePicker";
import { type ReferenceChoice, wholeReference } from "./reference-completion";
import { ParsedError, ValueField } from "./value-fields";
import { mappedText, mappedValue } from "./value-text";
import { DEFAULT_TZ, describeDuration } from "./wait-nodes";
import { ReferenceActions } from "./ZoomEditor";

type PackageNode = Extract<DocNode, { kind: "package" }>;
type AsyncNode = Extract<DocNode, { kind: "async" }>;
type TimerNode = Extract<DocNode, { kind: "timer" }>;
type SleepNode = Extract<DocNode, { kind: "sleep" }>;
type StopSubflowNode = Extract<DocNode, { kind: "stop_subflow" }>;
type FeishuNotifyNode = Extract<DocNode, { kind: "feishu_notify" }>;
type AlwaysNode = PackageNode | TimerNode | SleepNode | StopSubflowNode | FeishuNotifyNode;

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
			{type === undefined && <p className="m-0 text-xs text-fg-3">加载节点类型…</p>}
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
				引用在派发时解析；整值引用保持原类型。字符串里输入 <code>$</code> 或点「
				{ACTION.insertReference}」可以把引用和文字混写。
			</p>
			<SectionTitle>派发</SectionTitle>
			<Field label="Agent">
				<AgentSelect
					label="节点 Agent"
					value={node.agent}
					agents={agents}
					emptyLabel={`跟随默认（${defaultAgent ?? "未设置"}）`}
					onChange={(agent) => {
						const { agent: _old, ...rest } = node;
						onChange(agent ? { ...rest, agent } : rest);
					}}
				/>
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

/** 执行设置：超时、重试次数、排队超时（包节点），always（包节点、定时、Sleep、停止子流程、飞书通知）。 */
export function ExecutionSettings({
	id,
	node,
	onChange,
}: {
	id: string;
	node: AlwaysNode;
	onChange(node: AlwaysNode): void;
}) {
	return (
		<>
			{node.kind === "package" &&
				SETTINGS.map((s) => (
					<SettingField
						key={s.key}
						fieldKey={draftKey(id, s.key)}
						setting={s}
						value={node[s.key]}
						onChange={(value) => {
							const { [s.key]: _old, ...rest } = node;
							onChange(value === undefined ? rest : { ...rest, [s.key]: value });
						}}
					/>
				))}
			<Field label="always">
				<div className="flex h-7.5 items-center gap-2.5">
					<Switch
						aria-label="always"
						checked={node.always}
						onCheckedChange={(always) => onChange({ ...node, always })}
					/>
					<span className="text-xs text-fg-3">前面失败或运行被取消时仍执行</span>
				</div>
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
	setting: (typeof SETTINGS)[number];
	value: number | undefined;
	onChange(value: number | undefined): void;
}) {
	const id = useId();
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
		<Field label={setting.label} htmlFor={id} error={field.error} help={setting.help}>
			<Input
				id={id}
				inputMode="numeric"
				aria-invalid={field.error ? true : undefined}
				className="font-mono text-xs"
				placeholder={setting.placeholder}
				value={field.text}
				onChange={(e) => field.change(e.target.value)}
			/>
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
	doc: OrchestrationDocument;
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
	const id = useId();
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
	const invalid = problems.length > 0;
	return (
		<Field
			label={<span className="font-mono">{param.name}</span>}
			htmlFor={id}
			required={param.required}
			type={param.type}
			error={invalid ? <ParsedError fieldKey={fieldKey} problems={problems} /> : undefined}
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
					error={invalid ? <ParsedError fieldKey={fieldKey} problems={problems} /> : undefined}
					onChange={field.change}
				/>
			}
		>
			<ReferenceEditor
				ref={editor}
				id={id}
				label={label}
				value={field.text}
				choices={choices}
				placeholder={placeholder}
				invalid={invalid}
				onChange={field.change}
			/>
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
	const inputId = useId();
	return (
		<Field
			label="子流程名称"
			htmlFor={inputId}
			required
			error={problems.length > 0 ? problems.join("；") : undefined}
			help="场景内唯一；停止子流程节点按名称选择子流程，改名不影响引用"
		>
			<Input
				id={inputId}
				aria-invalid={problems.length > 0 || undefined}
				value={node.name ?? id}
				onChange={(e) => onChange({ ...node, name: e.target.value })}
			/>
		</Field>
	);
}

/**
 * 停止子流程节点：按名称选择要停止的子流程（SEMANTICS §4.1）。只列出合法候选——本链在它之前触发的子流程及其下级子流程；
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
	doc: OrchestrationDocument;
	problems: string[];
	onChange(node: StopSubflowNode): void;
	onLocate(id: string): void;
}) {
	const selectId = useId();
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
				htmlFor={selectId}
				required
				error={problems.length > 0 ? problems.join("；") : undefined}
				help="只列出本链在这个节点之前触发的子流程（含它们触发的子流程）；改名不影响引用"
			>
				<div className="flex items-center gap-2">
					<NativeSelect
						id={selectId}
						className="min-w-0 flex-1"
						aria-invalid={problems.length > 0 || undefined}
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
							<NativeSelectOption value={current}>{label(current)}（不能停止）</NativeSelectOption>
						)}
					</NativeSelect>
					{current !== undefined && entries.has(current) && (
						<Button size="sm" variant="ghost" onClick={() => onLocate(current)}>
							定位
						</Button>
					)}
				</div>
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
	doc: OrchestrationDocument;
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

const TIME_PRESETS = ["09:00:00", "09:30:00", "12:00:00", "15:00:00", "18:00:00"];
const DURATION_PRESETS = ["5s", "30s", "1m", "5m", "10m", "1h"];
const COMMON_TZ = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Europe/London", "UTC"];

function Presets({
	label,
	values,
	onPick,
}: {
	label: string;
	values: string[];
	onPick(v: string): void;
}) {
	return (
		<fieldset aria-label={label} className="m-0 flex flex-wrap gap-1 border-0 p-0">
			{values.map((v) => (
				<Button key={v} size="sm" className="font-mono" onClick={() => onPick(v)}>
					{v}
				</Button>
			))}
		</fieldset>
	);
}

/** 定时节点：触发时刻（HH:MM:SS 或日期时间）与时区。 */
export function TimerForm({
	node,
	problemsOf,
	onChange,
}: {
	node: TimerNode;
	problemsOf: ProblemsOf;
	onChange(node: TimerNode): void;
}) {
	const atId = useId();
	const tzId = useId();
	const tzList = useId();
	const atProblems = problemsOf("at");
	const tzProblems = problemsOf("tz");
	const tzValid = isTimeZone(node.tz);
	const target = tzValid ? timerTarget(node.at, node.tz, new Date(controlPlaneNow())) : null;
	const timeOfDay = /^\d{2}:\d{2}:\d{2}$/.test(node.at.trim());
	return (
		<>
			<Field
				label="触发时刻"
				htmlFor={atId}
				error={atProblems.length > 0 ? atProblems.join("；") : undefined}
				help={
					target
						? timeOfDay
							? "节点开始执行当天的该时刻；已过则立即成功并输出 late = true"
							: "到这个时刻触发；已过则立即成功并输出 late = true"
						: "HH:MM:SS，或 2026-01-02T09:30:00 这样的日期时间"
				}
			>
				<div className="flex flex-col gap-1.5">
					<Input
						id={atId}
						aria-invalid={atProblems.length > 0 || target === null || undefined}
						className="h-9 font-mono text-base"
						value={node.at}
						spellCheck={false}
						onChange={(e) => onChange({ ...node, at: e.target.value })}
					/>
					<Presets
						label="常用时刻"
						values={TIME_PRESETS}
						onPick={(at) => onChange({ ...node, at })}
					/>
				</div>
			</Field>
			<Field
				label="时区"
				htmlFor={tzId}
				error={tzProblems.length > 0 ? tzProblems.join("；") : undefined}
				help={`IANA 时区名，默认 ${DEFAULT_TZ}`}
			>
				<Input
					id={tzId}
					list={tzList}
					aria-invalid={!tzValid || undefined}
					className="font-mono text-xs"
					value={node.tz}
					spellCheck={false}
					onChange={(e) => onChange({ ...node, tz: e.target.value })}
				/>
				<datalist id={tzList}>
					{COMMON_TZ.map((tz) => (
						<option key={tz} value={tz} />
					))}
				</datalist>
			</Field>
		</>
	);
}

/** Sleep 节点：等待时长（可以引用参数或前序节点的输出）。 */
export function SleepForm({
	node,
	choices,
	problemsOf,
	onChange,
}: {
	node: SleepNode;
	choices: ReferenceChoice[];
	problemsOf: ProblemsOf;
	onChange(node: SleepNode): void;
}) {
	const id = useId();
	const editor = useRef<ReferenceEditorHandle>(null);
	const problems = problemsOf("duration");
	const hasReference = referencesIn(node.duration).length > 0;
	const ms = hasReference ? null : parseDuration(node.duration);
	return (
		<Field
			label="等待时长"
			htmlFor={id}
			aside={<InsertReferenceButton name="等待时长" editor={editor} />}
			error={problems.length > 0 ? problems.join("；") : undefined}
			help={
				hasReference
					? "执行时解析引用：得到 30s、10m 这样的时长，或按秒计的数字"
					: ms !== null
						? `等待 ${describeDuration(ms)}后继续`
						: "单位：ms、s、m、h、d，可以组合，如 1h30m"
			}
		>
			<div className="flex flex-col gap-1.5">
				<ReferenceEditor
					ref={editor}
					id={id}
					label="等待时长"
					value={node.duration}
					choices={choices}
					placeholder="30s、10m 或 ${{ params.<名称> }}"
					invalid={problems.length > 0 || (!hasReference && ms === null)}
					onChange={(duration) => onChange({ ...node, duration })}
				/>
				<Presets
					label="常用时长"
					values={DURATION_PRESETS}
					onPick={(duration) => onChange({ ...node, duration })}
				/>
			</div>
		</Field>
	);
}

const FORMAT_OPTIONS = [
	{ value: "text", label: "文本" },
	{ value: "card", label: "Markdown 卡片" },
	{ value: "raw", label: "原始消息" },
] as const;

const COLOR_LABELS: Record<FeishuNotifyNode["color"], string> = {
	blue: "蓝色",
	green: "绿色",
	orange: "橙色",
	red: "红色",
	grey: "灰色",
};

const REFERENCE_HELP =
	"可以输入 $ 或点「插入引用」写入入口参数和前面节点的输出；引用缺失时显示 null";

/**
 * 飞书通知节点（docs/SEMANTICS.md §1.3、§4.2，ADR 0020）：已登记的飞书机器人（下拉框，也可以改为整值引用入口参数）、
 * 消息格式（文本、Markdown 卡片、原始消息）和各格式自己的字段。切换格式时其他格式里填过的内容保留，只是不显示、不生效。
 * 消息由控制面发出，节点立即成功。
 */
export function FeishuNotifyForm({
	node,
	bots,
	choices,
	problemsOf,
	onChange,
}: {
	node: FeishuNotifyNode;
	bots: readonly FeishuBotView[];
	choices: ReferenceChoice[];
	problemsOf: ProblemsOf;
	onChange(node: FeishuNotifyNode): void;
}) {
	const botId = useId();
	const botProblems = problemsOf("bot");
	// 机器人只能引用入口参数：这样触发时就能检查它是已登记的机器人。
	const paramChoices = choices.filter((c) => c.kind === "param");
	const setBot = (bot: string | undefined) => {
		const { bot: _old, ...rest } = node;
		onChange(bot === undefined ? rest : { ...rest, bot });
	};
	const botLabel = "飞书机器人";
	const referenced = node.bot !== undefined && wholeReference(node.bot) !== undefined;
	const picker = (
		<ReferencePicker
			name={botLabel}
			choices={paramChoices}
			onPick={(choice) => setBot(choice.text)}
		/>
	);
	return (
		<>
			<Field
				label={botLabel}
				htmlFor={botId}
				required
				error={botProblems.length > 0 ? botProblems.join("；") : undefined}
				help="在「飞书机器人」页登记；也可以引用入口参数，触发时决定发到哪个群"
				aside={picker}
			>
				{referenced ? (
					<ReferenceChip
						label={botLabel}
						name="机器人"
						value={node.bot as string}
						invalid={botProblems.length > 0}
						onRemove={() => setBot(undefined)}
					/>
				) : (
					<FeishuBotSelect
						id={botId}
						label={botLabel}
						value={node.bot}
						bots={bots}
						emptyLabel="（选择机器人）"
						invalid={botProblems.length > 0}
						onChange={setBot}
					/>
				)}
			</Field>
			<Field label="格式">
				<Segmented
					label="格式"
					value={node.format}
					options={FORMAT_OPTIONS}
					onChange={(format) => onChange({ ...node, format })}
				/>
			</Field>
			{node.format === "text" && (
				<FeishuTextFields
					node={node}
					choices={choices}
					problemsOf={problemsOf}
					onChange={onChange}
				/>
			)}
			{node.format === "card" && (
				<FeishuCardFields
					node={node}
					choices={choices}
					problemsOf={problemsOf}
					onChange={onChange}
				/>
			)}
			{node.format === "raw" && (
				<FeishuRawField node={node} choices={choices} problemsOf={problemsOf} onChange={onChange} />
			)}
			<p className="m-0 text-xs text-fg-3">
				消息交给控制面的发送队列后节点立即成功；发不出去（飞书不可达、机器人不存在……）不会让节点或运行失败，
				原因写在节点日志里。
			</p>
		</>
	);
}

interface FeishuFieldsProps {
	node: FeishuNotifyNode;
	choices: ReferenceChoice[];
	problemsOf: ProblemsOf;
	onChange(node: FeishuNotifyNode): void;
}

/** 文本格式：文本（文字和引用混写）和「@所有人」开关。 */
function FeishuTextFields({ node, choices, problemsOf, onChange }: FeishuFieldsProps) {
	const textId = useId();
	const atAllId = useId();
	const editor = useRef<ReferenceEditorHandle>(null);
	const problems = problemsOf("text");
	return (
		<>
			<Field
				label="文本"
				htmlFor={textId}
				error={problems.length > 0 ? problems.join("；") : undefined}
				aside={
					<ReferenceActions
						editor={editor}
						name="文本"
						label="文本"
						value={node.text}
						choices={choices}
						placeholder="消息内容"
						invalid={problems.length > 0}
						error={problems.join("；")}
						onChange={(text) => onChange({ ...node, text })}
					/>
				}
				help={REFERENCE_HELP}
			>
				<ReferenceEditor
					ref={editor}
					id={textId}
					label="文本"
					value={node.text}
					choices={choices}
					placeholder="消息内容"
					invalid={problems.length > 0}
					onChange={(text) => onChange({ ...node, text })}
				/>
			</Field>
			<Field label="@所有人" htmlFor={atAllId}>
				<div className="flex h-7.5 items-center gap-2.5">
					<Switch
						id={atAllId}
						aria-label="@所有人"
						checked={node.at_all}
						onCheckedChange={(at_all) => onChange({ ...node, at_all })}
					/>
					<span className="text-xs text-fg-3">在正文末尾追加 @所有人</span>
				</div>
			</Field>
		</>
	);
}

/** Markdown 卡片：标题、标题颜色和 Markdown 正文；标题和正文里可以写引用。 */
function FeishuCardFields({ node, choices, problemsOf, onChange }: FeishuFieldsProps) {
	const titleId = useId();
	const colorId = useId();
	const markdownId = useId();
	const titleEditor = useRef<ReferenceEditorHandle>(null);
	const markdownEditor = useRef<ReferenceEditorHandle>(null);
	const titleProblems = problemsOf("title");
	const markdownProblems = problemsOf("markdown");
	return (
		<>
			<Field
				label="标题"
				htmlFor={titleId}
				aside={<InsertReferenceButton name="标题" editor={titleEditor} />}
				error={titleProblems.length > 0 ? titleProblems.join("；") : undefined}
				help="卡片顶部的标题；可以输入 $ 或点「插入引用」写入引用"
			>
				<ReferenceEditor
					ref={titleEditor}
					id={titleId}
					label="标题"
					value={node.title}
					choices={choices}
					placeholder="卡片标题"
					invalid={titleProblems.length > 0}
					onChange={(title) => onChange({ ...node, title })}
				/>
			</Field>
			<Field label="标题颜色" htmlFor={colorId}>
				<NativeSelect
					id={colorId}
					aria-label="标题颜色"
					value={node.color}
					onChange={(e) =>
						onChange({ ...node, color: e.target.value as FeishuNotifyNode["color"] })
					}
				>
					{FeishuCardColor.options.map((color) => (
						<NativeSelectOption key={color} value={color}>
							{COLOR_LABELS[color]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</Field>
			<Field
				label="正文"
				htmlFor={markdownId}
				error={markdownProblems.length > 0 ? markdownProblems.join("；") : undefined}
				aside={
					<ReferenceActions
						editor={markdownEditor}
						name="正文"
						label="正文"
						value={node.markdown}
						choices={choices}
						placeholder="Markdown 正文"
						invalid={markdownProblems.length > 0}
						error={markdownProblems.join("；")}
						onChange={(markdown) => onChange({ ...node, markdown })}
					/>
				}
				help={`Markdown 正文，超过 ${FEISHU_BODY_LIMIT_LABEL} 时截断。${REFERENCE_HELP}`}
			>
				<ReferenceEditor
					ref={markdownEditor}
					id={markdownId}
					label="正文"
					value={node.markdown}
					choices={choices}
					placeholder="Markdown 正文"
					invalid={markdownProblems.length > 0}
					minLines={4}
					onChange={(markdown) => onChange({ ...node, markdown })}
				/>
			</Field>
		</>
	);
}

/**
 * 原始消息：完整的飞书请求体（JSON 对象），原样发出。用的是包节点 `json` 类型输入的同一个控件：
 * 字符串字段里可以写引用，也可以整个值引用一个 json 类型的入口参数。
 */
function FeishuRawField({ node, choices, problemsOf, onChange }: FeishuFieldsProps) {
	return (
		<ValueField
			nodeId={node.id}
			name="message"
			heading="原始消息"
			label="原始消息"
			schema={{ type: "object" }}
			required
			value={node.message}
			choices={choices}
			problems={problemsOf("message")}
			help={`完整的飞书请求体，原样发出，不截断；msg_type 必须是 ${FEISHU_MSG_TYPES.join("、")} 之一，整个请求体不超过 ${FEISHU_BODY_LIMIT_LABEL}。字符串字段里可以写引用。`}
			onChange={(message) => {
				const { message: _old, ...rest } = node;
				onChange(message === undefined ? rest : { ...rest, message });
			}}
		/>
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
