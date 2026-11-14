import type { PresetView } from "@sfly/schema";
import { useId } from "react";
import { problemsText } from "#/presets/invalid-preset";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/** 「管理预设…」选项的值：不是预设 ID，选中它只是打开管理对话框，选择框里的选中项不变。 */
const MANAGE = "manage";

/**
 * 运行抽屉参数表单上方的运行预设选择框：「不使用预设」加上场景的各个预设（预检返回的顺序，按名称排序），最后是「管理预设…」。
 * 选中一个预设，它的预设参数就锁定为预设的值（TriggerForm）。失效的运行预设能看到但不能选，名称后面写明原因。
 * 不使用预设时标签旁有「存为预设」，把现在填的值存成新预设。
 */
export function PresetSelect({
	presets,
	value,
	onChange,
	onManage,
	onSaveAs,
	selectRef,
}: {
	presets: readonly PresetView[];
	/** 选中的预设 ID；不使用预设时为 null。 */
	value: string | null;
	onChange: (presetId: string | null) => void;
	onManage: () => void;
	onSaveAs: () => void;
	/** 管理对话框关闭后焦点回到这里。 */
	selectRef?: React.Ref<HTMLSelectElement>;
}) {
	const id = useId();
	return (
		<div className="mb-4.5 flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-2">
				<label htmlFor={id} className="text-xs font-semibold tracking-wide text-fg-2">
					运行预设
				</label>
				{value === null && (
					<Button variant="link" size="sm" className="text-xs" onClick={onSaveAs}>
						存为预设
					</Button>
				)}
			</div>
			<NativeSelect
				id={id}
				ref={selectRef}
				value={value ?? ""}
				onChange={(e) =>
					e.target.value === MANAGE ? onManage() : onChange(e.target.value || null)
				}
			>
				<NativeSelectOption value="">不使用预设</NativeSelectOption>
				{presets.map((preset) => (
					<NativeSelectOption
						key={preset.id}
						value={preset.id}
						disabled={preset.status === "invalid"}
					>
						{preset.status === "invalid"
							? `${preset.name} · 已失效：${problemsText(preset.problems)}`
							: preset.name}
					</NativeSelectOption>
				))}
				<NativeSelectOption value={MANAGE}>管理预设…</NativeSelectOption>
			</NativeSelect>
		</div>
	);
}
