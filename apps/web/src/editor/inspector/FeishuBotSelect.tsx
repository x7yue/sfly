import type { FeishuBotView } from "@sfly/schema";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/**
 * 选择一个已登记的飞书机器人（ADR 0020）：值不是已登记的机器人时仍保留在列表里，标出「未登记」。
 * 用于飞书通知节点，以及「飞书机器人」类型的输入。
 */
export function FeishuBotSelect({
	id,
	label,
	value,
	bots,
	emptyLabel,
	invalid,
	onChange,
}: {
	id?: string;
	label: string;
	value: string | undefined;
	bots: readonly FeishuBotView[];
	emptyLabel: string;
	invalid?: boolean;
	onChange(value: string | undefined): void;
}) {
	return (
		<NativeSelect
			id={id}
			aria-label={label}
			aria-invalid={invalid || undefined}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			<NativeSelectOption value="">{emptyLabel}</NativeSelectOption>
			{bots.map((b) => (
				<NativeSelectOption key={b.name} value={b.name}>
					{b.name}
				</NativeSelectOption>
			))}
			{value && !bots.some((b) => b.name === value) && (
				<NativeSelectOption value={value}>{value}（未登记）</NativeSelectOption>
			)}
		</NativeSelect>
	);
}
