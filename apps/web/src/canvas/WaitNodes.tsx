// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	isTimeZone,
	type OrchestrationWarning,
	parseDuration,
	type ReferenceOption,
	referencesIn,
	timerTarget,
} from "@sfly/orchestration";
import type { NodeRunView } from "#/runs/api";
import { formatDuration } from "#/runs/format";
import type { DocNode } from "./flow";
import { Icon } from "./icons";
import { KIND_LABEL, KindChip } from "./NodeCard";
import { ReferenceInput } from "./ReferenceInput";

/**
 * 内置等待节点（定时节点、Sleep 节点，docs/SEMANTICS.md §5）在画布上的部分：
 * 节点面板里的条目、新节点的默认配置、检查器里的配置表单、运行模式的指标槽。
 * 视觉沿用原型 inspector.css 的 cron 输入（等宽大输入框 + 有效性图标 + 自然语言解释 + 常用值），样式在 wait-nodes.css。
 */

export type WaitKind = "timer" | "sleep";
type TimerNode = Extract<DocNode, { kind: "timer" }>;
type SleepNode = Extract<DocNode, { kind: "sleep" }>;

/** 从节点面板拖出内置等待节点时携带的数据（值为节点种类）。 */
export const WAIT_PALETTE_MIME = "application/x-sfly-wait-node";

export const DEFAULT_TZ = "Asia/Shanghai";

/** 检查器里就地显示的配置项（这些输入的警告不再重复列在警告区）。 */
export const WAIT_INPUTS = new Set(["at", "tz", "duration"]);

export const isWaitKind = (kind: string): kind is WaitKind => kind === "timer" || kind === "sleep";

/** 新放置的等待节点的默认配置。 */
export function newWaitNode(kind: WaitKind, id: string): DocNode {
	return kind === "timer"
		? { id, kind, always: false, at: "09:30:00", tz: DEFAULT_TZ }
		: { id, kind, always: false, duration: "30s" };
}

const PALETTE: { kind: WaitKind; hint: string }[] = [
	{ kind: "timer", hint: "等到某个时刻" },
	{ kind: "sleep", hint: "等待一段时长" },
];

/** 节点面板里的「内置节点」分组：定时节点和 Sleep 节点（不占用 Agent）。 */
export function WaitNodePalette({ onAdd }: { onAdd(kind: WaitKind): void }) {
	return (
		<ul className="space-y-1.5 px-3.5 pt-3.5">
			{PALETTE.map(({ kind, hint }) => (
				<li key={kind}>
					<button
						type="button"
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData(WAIT_PALETTE_MIME, kind);
							e.dataTransfer.effectAllowed = "copy";
						}}
						onClick={() => onAdd(kind)}
						title="拖到画布上，或点击添加到画布中央"
						className="sf-palette-item"
					>
						<KindChip kind={kind} />
						<span className="min-w-0">
							<span className="block truncate text-[13px] font-medium">{KIND_LABEL[kind]}</span>
							<span className="block truncate text-[11.5px] text-[var(--sf-text-3)]">
								{hint} · 控制面执行
							</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

const TIME_PRESETS = ["09:00:00", "09:30:00", "12:00:00", "15:00:00", "18:00:00"];
const DURATION_PRESETS = ["30s", "1m", "5m", "10m", "30m", "1h"];
const COMMON_TZ = [
	"Asia/Shanghai",
	"Asia/Hong_Kong",
	"Asia/Tokyo",
	"Asia/Singapore",
	"Europe/London",
	"America/New_York",
	"UTC",
];

/** 时刻在时区里的显示：2026-01-02 09:30:00。 */
function wallTime(date: Date, tz: string): string {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(date);
}

/** 时长的中文描述：1 小时 30 分 5 秒。 */
export function describeDuration(ms: number): string {
	if (ms === 0) return "0 秒（立即继续）";
	const parts: string[] = [];
	let rest = ms;
	for (const [unit, label] of [
		[86_400_000, "天"],
		[3_600_000, "小时"],
		[60_000, "分"],
		[1000, "秒"],
		[1, "毫秒"],
	] as const) {
		const n = Math.floor(rest / unit);
		if (n > 0) parts.push(`${n} ${label}`);
		rest -= n * unit;
	}
	return parts.join(" ");
}

function warningsFor(warnings: OrchestrationWarning[], input: string) {
	return warnings.filter((w) => "input" in w && w.input === input);
}

/** 原型的 cron 输入：等宽大输入框，右侧是有效性图标。 */
function BigInput({
	value,
	label,
	valid,
	placeholder,
	onChange,
}: {
	value: string;
	label: string;
	valid: boolean;
	placeholder?: string;
	onChange(value: string): void;
}) {
	return (
		<div className={`sf-wait-in ${valid ? "" : "sf-wait-in--bad"}`}>
			<input
				aria-label={label}
				aria-invalid={!valid}
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
			/>
			<span className="sf-wait-in__ok" aria-hidden="true">
				<Icon name={valid ? "check" : "alert"} />
			</span>
		</div>
	);
}

function Presets({
	values,
	label,
	onPick,
}: {
	values: string[];
	label: string;
	onPick(v: string): void;
}) {
	return (
		<fieldset className="sf-presets" aria-label={label}>
			{values.map((v) => (
				<button key={v} type="button" onClick={() => onPick(v)}>
					{v}
				</button>
			))}
		</fieldset>
	);
}

function Problems({ warnings }: { warnings: OrchestrationWarning[] }) {
	return warnings.map((w) => (
		<p key={`${w.code}:${w.message}`} className="sf-wait-err">
			<Icon name="alert" />
			{w.message}
		</p>
	));
}

/** 定时节点的配置：时刻（HH:MM:SS 或完整日期时间）和时区。 */
export function TimerSettings({
	node,
	warnings,
	onChange,
}: {
	node: TimerNode;
	warnings: OrchestrationWarning[];
	onChange(node: TimerNode): void;
}) {
	const atProblems = warningsFor(warnings, "at");
	const tzProblems = warningsFor(warnings, "tz");
	const tzValid = isTimeZone(node.tz);
	const timeOfDay = /^\d{2}:\d{2}:\d{2}$/.test(node.at.trim());
	// 预览：如果节点此刻开始执行，会在什么时候触发。
	const now = new Date();
	const target = tzValid ? timerTarget(node.at, node.tz, now) : null;
	return (
		<>
			<section className="sf-sec">
				<h3>
					<Icon name="clock" />
					触发时刻
					<span className="sf-r">只触发一次 · {tzValid ? node.tz : "时区无效"}</span>
				</h3>
				<BigInput
					label="触发时刻"
					value={node.at}
					valid={atProblems.length === 0 && target !== null}
					placeholder="HH:MM:SS 或 2026-01-02T09:30:00"
					onChange={(at) => onChange({ ...node, at })}
				/>
				<Problems warnings={atProblems} />
				{target && (
					<div className="sf-nl">
						<div className="sf-nl__v">
							{timeOfDay
								? `节点开始执行当天的 ${node.at.trim()}（${node.tz}）触发`
								: `${wallTime(target, node.tz)}（${node.tz}）触发`}
						</div>
						<div className="sf-nl__nx">
							<div>
								<span>若此刻开始</span>
								<em>
									{target.getTime() <= now.getTime()
										? "时刻已过，立即成功（late = true）"
										: `${wallTime(target, node.tz)} · ${formatDuration(target.getTime() - now.getTime())} 后`}
								</em>
							</div>
							<div>
								<span>输出</span>
								<em>triggered_at · late</em>
							</div>
						</div>
					</div>
				)}
				<Presets
					label="常用时刻"
					values={TIME_PRESETS}
					onPick={(at) => onChange({ ...node, at })}
				/>
			</section>
			<section className="sf-sec">
				<div className="sf-field">
					<label htmlFor={`tz-${node.id}`}>时区</label>
					<input
						id={`tz-${node.id}`}
						className={`sf-inp sf-inp--mono ${tzValid ? "" : "sf-inp--bad"}`}
						list={`tz-list-${node.id}`}
						value={node.tz}
						spellCheck={false}
						onChange={(e) => onChange({ ...node, tz: e.target.value })}
					/>
					<datalist id={`tz-list-${node.id}`}>
						{COMMON_TZ.map((tz) => (
							<option key={tz} value={tz} />
						))}
					</datalist>
				</div>
				<Problems warnings={tzProblems} />
				<p className="sf-hint">
					IANA 时区名，默认 <code>{DEFAULT_TZ}</code>。<code>HH:MM:SS</code>{" "}
					按这个时区的当天计算；日期时间不带偏移时也按这个时区，带 <code>Z</code> /{" "}
					<code>+08:00</code> 时按偏移。
				</p>
			</section>
		</>
	);
}

/** Sleep 节点的配置：时长（可以引用参数或前面节点的输出）。 */
export function SleepSettings({
	node,
	options,
	warnings,
	onChange,
}: {
	node: SleepNode;
	options: ReferenceOption[];
	warnings: OrchestrationWarning[];
	onChange(node: SleepNode): void;
}) {
	const problems = warningsFor(warnings, "duration");
	const hasReference = referencesIn(node.duration).length > 0;
	const ms = hasReference ? null : parseDuration(node.duration);
	return (
		<section className="sf-sec">
			<h3>
				<Icon name="timer" />
				等待时长
				<span className="sf-r">可以引用参数</span>
			</h3>
			<ReferenceInput
				label="等待时长"
				value={node.duration}
				options={options}
				placeholder="30s、10m、1h30m 或 ${{ params.<名称> }}"
				invalid={problems.length > 0 || (!hasReference && ms === null)}
				onChange={(duration) => onChange({ ...node, duration })}
			/>
			<Problems warnings={problems} />
			<div className="sf-nl">
				<div className="sf-nl__v">
					{hasReference
						? "执行时解析引用：得到 30s、10m 这样的时长，或按秒计的数字"
						: ms !== null
							? `等待 ${describeDuration(ms)}后继续`
							: "单位：ms、s、m、h、d，可以组合，如 1h30m"}
				</div>
				<div className="sf-nl__nx">
					<div>
						<span>输出</span>
						<em>triggered_at</em>
					</div>
				</div>
			</div>
			<Presets
				label="常用时长"
				values={DURATION_PRESETS}
				onPick={(duration) => onChange({ ...node, duration })}
			/>
		</section>
	);
}

/**
 * 运行模式的指标槽：等待中显示唤醒时间和剩余时长；定时节点迟到（late）时标出。
 * 其他情况返回 undefined，用通用的指标。
 */
export function waitRunMetrics(
	node: DocNode,
	run: NodeRunView,
	now: number,
): [string, string][] | undefined {
	if (!isWaitKind(node.kind)) return undefined;
	const last = run.attempts.at(-1);
	const tz = node.kind === "timer" ? node.tz : DEFAULT_TZ;
	if (run.status === "waiting" && last?.wake_at) {
		const wake = new Date(last.wake_at);
		return [
			["唤醒", isTimeZone(tz) ? wallTime(wake, tz).slice(11) : last.wake_at],
			["剩余", formatDuration(wake.getTime() - now)],
		];
	}
	if (node.kind === "timer" && run.status === "success" && run.outputs?.late === true) {
		return [
			["at", node.at],
			["late", "时刻已过，立即成功"],
		];
	}
	return undefined;
}
