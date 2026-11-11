import { cn } from "cn";
import type { KeyLabel } from "@/lib/shortcuts";

/**
 * 一个按键。内容只能是注册表给出的按键文字（见 KeyLabel），不能写死：`<Kbd>Ctrl S</Kbd>` 会报
 * TS2745（「expects type 'KeyLabel'」），改用 shortcutText / shortcutKeys。
 */
function Kbd({
	className,
	...props
}: Omit<React.ComponentProps<"kbd">, "children"> & { children: KeyLabel }) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"pointer-events-none inline-grid h-4.5 min-w-4.5 place-items-center rounded-sm border border-b-2 border-border bg-raised px-1.25 font-mono text-2xs text-fg-2 select-none [&_svg:not([class*='size-'])]:size-3",
				className,
			)}
			{...props}
		/>
	);
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<kbd
			data-slot="kbd-group"
			className={cn("inline-flex items-center gap-1", className)}
			{...props}
		/>
	);
}

export { Kbd, KbdGroup };
