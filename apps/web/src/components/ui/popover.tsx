import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";

/**
 * 浮动面板（Base UI Popover）：点触发按钮打开，Esc 与点外面关闭，关闭后焦点回到触发按钮。
 * 弹出层 role=dialog，名称取 `PopoverContent` 的 aria-label 或里面的 `PopoverTitle`。
 */
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
	align = "start",
	side = "bottom",
	sideOffset = 4,
	className,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						"z-50 flex max-h-(--available-height) origin-(--transform-origin) flex-col rounded-lg border border-border-strong bg-raised p-2.5 text-fg-1 shadow-pop outline-none",
						className,
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export { Popover, PopoverClose, PopoverContent, PopoverTrigger };
