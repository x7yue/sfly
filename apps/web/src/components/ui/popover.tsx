import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";
import { MENU_SURFACE, POPUP_MOTION } from "@/components/ui/overlay";

/**
 * 弹出层（Base UI Popover）：Esc 与点外面关闭，关闭后焦点回到打开前的元素。
 * 默认贴着 Trigger；`anchor` 可以换成任意元素或虚拟元素（例如画布上松开鼠标的位置）。
 */
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
	className,
	align = "center",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	anchor,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "anchor"
	>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				anchor={anchor}
				className="isolate z-50"
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						"z-50 max-h-(--available-height) origin-(--transform-origin) overflow-hidden",
						MENU_SURFACE,
						POPUP_MOTION,
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

export { Popover, PopoverClose, PopoverTrigger, PopoverContent };
