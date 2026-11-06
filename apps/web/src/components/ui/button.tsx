import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/**
 * 按钮（shadcn/ui base-nova 拉取后按设计体系改写）。
 * - `primary` 是白色主操作：每屏只用一次（页面的主操作，如「新建场景」）。
 * - 默认是中性按钮；`ghost` 用于工具栏和次要操作；`danger` 只放在确认弹窗等危险操作处。
 * - 尺寸：默认 30px 高，`sm` 26px；`icon` / `icon-sm` 为正方形图标按钮（必须带 aria-label）。
 * 焦点环来自 app.css 的全局 :focus-visible（青色），这里不覆盖。
 */
const buttonVariants = cva(
	"inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors duration-150 ease-standard select-none disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "border-border bg-raised text-fg-1 hover:bg-raised-2 aria-expanded:bg-raised-2",
				primary: "border-primary bg-primary text-primary-foreground hover:bg-primary-hover",
				ghost:
					"border-transparent bg-transparent text-fg-2 hover:bg-raised hover:text-fg-1 aria-expanded:bg-raised aria-expanded:text-fg-1",
				danger: "border-danger-line bg-transparent text-danger-fg hover:bg-danger-soft",
				"danger-solid": "border-danger bg-danger text-white hover:opacity-90",
				link: "h-auto! border-transparent p-0! text-fg-1 underline underline-offset-2 hover:text-primary-hover",
			},
			size: {
				default: "h-7.5 px-3 text-sm",
				sm: "h-6.5 px-2.25 text-xs [&_svg:not([class*='size-'])]:size-3.5",
				icon: "size-7.5",
				"icon-sm": "size-6.5 [&_svg:not([class*='size-'])]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			data-variant={variant}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
