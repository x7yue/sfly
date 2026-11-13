import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

/**
 * 开关（shadcn/ui base-nova 拉取后按设计体系改写，原型 `.sw`）：30 × 18。关闭时 track 底色、灰色圆点；
 * 打开时与勾选框一样是中性高亮（`selected` 底、深色圆点），不用绿色：「必填 = 是」不是「成功」。
 * 焦点环沿用全局青色 :focus-visible。
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
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
}

export { Switch };
