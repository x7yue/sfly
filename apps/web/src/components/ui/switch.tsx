import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

/**
 * 开关（shadcn/ui base-nova 拉取后按设计体系改写，原型 `.sw`）：30 × 18，关闭时 track 底色，
 * 打开时绿色（启用）底 + 白色圆点。焦点环沿用全局青色 :focus-visible。
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"relative inline-flex h-4.5 w-7.5 shrink-0 cursor-pointer items-center rounded-full bg-track transition-colors data-checked:bg-ok data-disabled:cursor-not-allowed data-disabled:opacity-40",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none ml-0.5 block size-3.5 rounded-full bg-fg-2 transition-transform data-checked:translate-x-3 data-checked:bg-white"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
