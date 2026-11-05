// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	dispatchTarget,
	isTimeZone,
	NODE_DEFAULTS,
	type NodeTypeIo,
	orderedInputs,
	parseDuration,
	referencesIn,
	timerTarget,
} from "@sfly/orchestration";
import type { AgentView, OrchestrationDocument, PackageSummary } from "@sfly/schema";
import { useId } from "react";
import type { DocNode } from "#/components/canvas/flow";
import { latestVersion } from "#/lib/package-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { agentsWithDev } from "../catalog";
import { draftKey, useParsedField } from "../field-drafts";
import { Field, type ReferenceChoice, ReferenceTextInput, SectionTitle } from "./fields";
import { ValueField } from "./value-fields";
import { DEFAULT_TZ, describeDuration } from "./wait-nodes";

type PackageNode = Extract<DocNode, { kind: "package" }>;
type AsyncNode = Extract<DocNode, { kind: "async" }>;
type TimerNode = Extract<DocNode, { kind: "timer" }>;
type SleepNode = Extract<DocNode, { kind: "sleep" }>;
type AlwaysNode = PackageNode | TimerNode | SleepNode;

/** 某个字段的静态检查警告（不阻止保存）。 */
export type ProblemsOf = (input: string) => string[];

/** 开发版本的版本号（`包名@dev`）。 */
const DEV_VERSION = "dev";

export function AgentSelect({
	label,
	value,
	agents,
	emptyLabel,
	onChange,
}: {
	label: string;
	value: string | undefined;
	agents: AgentView[];
	emptyLabel: string;
	onChange(value: string | undefined): void;
}) {
	const names = agents.map((a) => a.name);
	return (
		<NativeSelect
			aria-label={label}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			<NativeSelectOption value="">{emptyLabel}</NativeSelectOption>
			{agents.map((a) => (
				<NativeSelectOption key={a.name} value={a.name}>
					{a.name} · {a.status === "online" ? "在线" : "离线"} · {a.running_tasks.length}/
					{a.info.slots} 槽位
				</NativeSelectOption>
			))}
			{value && !names.includes(value) && (
				<NativeSelectOption value={value}>{value}（未注册）</NativeSelectOption>
			)}
		</NativeSelect>
	);
}

/** 包节点的「参数」页：按输入 schema 生成的表单，以及节点的 Agent。 */
export function PackageParams({
	id,
	node,
	type,
	choices,
	problemsOf,
	defaultAgent,
	agents,
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
			<p className="m-0 text-2xs text-fg-3">
				引用在派发时解析；整值引用保持原类型。字符串里输入 <code>{"${{"}</code> 可以内嵌引用。
			</p>
			<SectionTitle>Agent</SectionTitle>
			<Field label="执行机器">
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

/** 执行设置：超时、重试次数、排队超时（包节点），always（包节点、定时、Sleep）。 */
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
				<p className="m-0 text-2xs text-fg-3">由控制面执行，不占用 Agent 槽位。</p>
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

/** 输入框文本 → 映射值：目标参数不是 string 时，不含引用的 JSON 字面量按常量保存。 */
function mappedValue(text: string, type: string): unknown {
	if (type === "string" || text.includes("${{")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
const textOf = (value: unknown) =>
	value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

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
		if (value === undefined || value === "") delete params[name];
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
					<Badge className="font-mono">◆ {subflow.id}</Badge>
					<Button size="sm" variant="ghost" onClick={() => onLocate(subflow.id)}>
						定位
					</Button>
				</div>
			</Field>
			<SectionTitle>参数映射（按值传入）</SectionTitle>
			{subflow.params.length === 0 && (
				<p className="m-0 text-xs text-fg-3">子流程入口 {subflow.id} 没有声明参数。</p>
			)}
			{subflow.params.map((p) => {
				const problems = problemsOf(p.name);
				return (
					<Field
						key={p.name}
						label={<span className="font-mono">{p.name}</span>}
						required={p.required}
						type={p.type}
						error={problems.length > 0 ? problems.join("；") : undefined}
					>
						<ReferenceTextInput
							label={`子流程参数 ${p.name}`}
							value={textOf(node.params[p.name])}
							choices={choices}
							placeholder={p.default !== undefined ? `默认 ${textOf(p.default)}` : p.type}
							invalid={problems.length > 0}
							onChange={(text) =>
								setParam(p.name, text === "" ? undefined : mappedValue(text, p.type))
							}
						/>
					</Field>
				);
			})}
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
			<p className="m-0 text-2xs text-fg-3">
				子流程只能看到这里传入的参数；可以写常量，或输入 <code>{"${{"}</code>{" "}
				引用本链的入口参数和前序节点的输出。
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
	const target = tzValid ? timerTarget(node.at, node.tz, new Date()) : null;
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
	const problems = problemsOf("duration");
	const hasReference = referencesIn(node.duration).length > 0;
	const ms = hasReference ? null : parseDuration(node.duration);
	return (
		<Field
			label="等待时长"
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
				<ReferenceTextInput
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
