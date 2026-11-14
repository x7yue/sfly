import type { ParamDeclView, PresetView } from "@sfly/schema";
import { useId } from "react";
import { problemsText } from "#/presets/invalid-preset";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/**
 * 运行抽屉参数表单上方的运行预设选择框：「不使用预设」加上场景的各个预设（预检返回的顺序，按名称排序）。
 * 选中一个预设，它的预设参数就锁定为预设的值（TriggerForm）。失效的运行预设能看到但不能选，名称后面写明原因。
 */
export function PresetSelect({
	presets,
	decls,
	value,
	onChange,
}: {
	presets: readonly PresetView[];
	/** 预检返回的入口参数声明，失效的原因里写明参数现在的类型。 */
	decls: ParamDeclView[];
	/** 选中的预设 ID；不使用预设时为 null。 */
	value: string | null;
	onChange: (presetId: string | null) => void;
}) {
	const id = useId();
	return (
		<div className="mb-4.5 flex flex-col gap-2.5">
			<label htmlFor={id} className="text-xs font-semibold tracking-wide text-fg-2">
				运行预设
			</label>
			<NativeSelect id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
				<NativeSelectOption value="">不使用预设</NativeSelectOption>
				{presets.map((preset) => (
					<NativeSelectOption
						key={preset.id}
						value={preset.id}
						disabled={preset.status === "invalid"}
					>
						{preset.status === "invalid"
							? `${preset.name} · 已失效：${problemsText(preset.problems, decls)}`
							: preset.name}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}
