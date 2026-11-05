import { NODE_DEFAULTS } from "@sfly/orchestration";
import { useState } from "react";
import type { DocNode } from "./flow";

type PackageNode = Extract<DocNode, { kind: "package" }>;
type AlwaysNode = Extract<DocNode, { kind: "package" | "timer" | "sleep" }>;
type Setting = "timeout" | "retries" | "queue_timeout";

const formatSeconds = (s: number) =>
	s % 3600 === 0 ? `${s / 3600} 小时` : s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`;

const SETTINGS: { key: Setting; label: string; unit: string; min: number; hint: string }[] = [
	{
		key: "timeout",
		label: "超时",
		unit: "秒",
		min: 1,
		hint: `默认 ${formatSeconds(NODE_DEFAULTS.timeout)}`,
	},
	{
		key: "retries",
		label: "重试次数",
		unit: "次",
		min: 0,
		hint: `默认 ${NODE_DEFAULTS.retries} 次`,
	},
	{
		key: "queue_timeout",
		label: "排队超时",
		unit: "秒",
		min: 1,
		hint: `默认 ${formatSeconds(NODE_DEFAULTS.queue_timeout)}`,
	},
];

/** always 开关：前面失败或运行被取消时仍然执行（异步任务节点不能设置）。 */
export function AlwaysToggle<N extends AlwaysNode>({
	node,
	onChange,
}: {
	node: N;
	onChange(node: N): void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={node.always}
			className="sf-tg"
			onClick={() => onChange({ ...node, always: !node.always })}
		>
			<span className="sf-tx">
				<b>always</b>
				<span>前面的节点失败或运行被取消时仍然执行，用于清理现场。</span>
			</span>
			<span className="sf-sw" aria-hidden="true" />
		</button>
	);
}

/** 包节点的执行配置：超时、重试次数、排队超时；留空使用默认值。 */
export function ExecutionSettings({
	node,
	onChange,
}: {
	node: PackageNode;
	onChange(node: PackageNode): void;
}) {
	return (
		<div>
			{SETTINGS.map((s) => (
				<SettingField
					key={s.key}
					setting={s}
					value={node[s.key]}
					onChange={(value) => {
						const { [s.key]: _old, ...rest } = node;
						onChange(value === undefined ? rest : { ...rest, [s.key]: value });
					}}
				/>
			))}
			<p className="sf-hint">
				留空时使用默认值。超时从任务开始运行时计时；排队超时是等待 Agent 空闲槽位的最长时间。
			</p>
		</div>
	);
}

function SettingField({
	setting,
	value,
	onChange,
}: {
	setting: (typeof SETTINGS)[number];
	value: number | undefined;
	onChange(value: number | undefined): void;
}) {
	const [text, setText] = useState(value === undefined ? "" : String(value));
	const n = Number(text);
	const invalid = text.trim() !== "" && (!Number.isInteger(n) || n < setting.min);
	const id = `setting-${setting.key}`;
	return (
		<>
			<div className="sf-field">
				<label htmlFor={id}>{setting.label}</label>
				<div className="flex items-center gap-2">
					<input
						id={id}
						inputMode="numeric"
						className={`sf-inp sf-inp--mono ${invalid ? "sf-inp--bad" : ""}`}
						placeholder={setting.hint}
						value={text}
						onChange={(e) => {
							const raw = e.target.value;
							setText(raw);
							const v = Number(raw);
							if (raw.trim() === "") onChange(undefined);
							else if (Number.isInteger(v) && v >= setting.min) onChange(v);
						}}
					/>
					<span className="w-6 shrink-0 text-xs text-[var(--sf-text-3)]">{setting.unit}</span>
				</div>
			</div>
			{invalid && (
				<p className="sf-err mb-2">{setting.min > 0 ? "需要正整数" : "需要非负整数"}，未生效</p>
			)}
		</>
	);
}
