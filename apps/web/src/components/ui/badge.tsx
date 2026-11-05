import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/**
 * 徽标：版本号、计数、标签。状态请用 StatusPill（#/components/status），徽标只在需要「框起来」时带状态色。
 */
const badgeVariants = cva(
	"inline-flex h-5 w-fit shrink-0 items-center gap-1.25 overflow-hidden rounded-md border px-1.75 text-2xs whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				default: "border-border bg-raised-2 text-fg-2",
				ok: "border-ok-line bg-ok-soft text-ok",
				warn: "border-warn-line bg-warn-soft text-warn",
				danger: "border-danger-line bg-danger-soft text-danger-fg",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };
