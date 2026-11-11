import type { AgentView } from "@sfly/schema";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/**
 * 选择一台已注册的 Agent：列出每台的在线状态（`slots` 时再列出槽位占用）；值不是已注册的 Agent 时
 * 仍保留在列表里，标出「未注册」。用于节点 / 场景的执行机器，以及「Agent」类型的输入。
 */
export function AgentSelect({
	id,
	label,
	value,
	agents,
	emptyLabel,
	slots = true,
	invalid,
	onChange,
}: {
	id?: string;
	label: string;
	value: string | undefined;
	agents: AgentView[];
	emptyLabel: string;
	slots?: boolean;
	invalid?: boolean;
	onChange(value: string | undefined): void;
}) {
	const names = agents.map((a) => a.name);
	return (
		<NativeSelect
			id={id}
			aria-label={label}
			aria-invalid={invalid || undefined}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			<NativeSelectOption value="">{emptyLabel}</NativeSelectOption>
			{agents.map((a) => (
				<NativeSelectOption key={a.name} value={a.name}>
					{a.name} · {a.status === "online" ? "在线" : "离线"}
					{slots && ` · ${a.running_tasks.length}/${a.info.slots} 槽位`}
				</NativeSelectOption>
			))}
			{value && !names.includes(value) && (
				<NativeSelectOption value={value}>{value}（未注册）</NativeSelectOption>
			)}
		</NativeSelect>
	);
}
