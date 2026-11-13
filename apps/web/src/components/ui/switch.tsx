import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

/**
 * 开关（shadcn/ui base-nova 拉取后按设计体系改写，原型 `.sw`）：30 × 18。关闭时 track 底色、灰色圆点；
 * 打开时与勾选框一样是中性高亮（`selected` 底、深色圆点），不用绿色：「必填 = 是」不是「成功」。
 * 焦点环沿用全局青色 :focus-visible。
 *
 * `label`：开关旁的文字。给了就用 `<label>` 把开关和文字包在一起，点文字也能切换，文字就是开关的名称
 * （不再另写 aria-label）。长的说明不要放进 label，写在旁边，用 `aria-describedby` 关联。
 *
 *   <Switch label="必填" checked={required} onCheckedChange={setRequired} />
 */
function Switch({
	className,
	label,
	...props
}: SwitchPrimitive.Root.Props & { label?: React.ReactNode }) {
	const control = (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"relative inline-flex h-4.5 w-7.5 shrink-0 cursor-pointer items-center rounded-full border border-border-control bg-track transition-colors data-checked:border-selected data-checked:bg-selected data-disabled:cursor-not-allowed data-disabled:opacity-40 forced-colors:border-[color:CanvasText] forced-colors:bg-[color:Canvas] forced-colors:forced-color-adjust-none forced-colors:data-checked:bg-[color:Highlight]",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none ml-px block size-3.5 rounded-full bg-fg-2 transition-[translate,background-color] data-checked:translate-x-3 data-checked:bg-primary-foreground forced-colors:bg-[color:CanvasText] forced-colors:data-checked:bg-[color:HighlightText]"
			/>
		</SwitchPrimitive.Root>
	);
	if (label === undefined) return control;
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: 控件是里面的 Switch.Root（role=switch 加隐藏的 input），biome 认不出
		<label
			data-slot="switch-label"
			data-disabled={props.disabled || undefined}
			className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-2 select-none data-disabled:cursor-not-allowed data-disabled:text-fg-3"
		>
			{control}
			{label}
		</label>
	);
}

export { Switch };
