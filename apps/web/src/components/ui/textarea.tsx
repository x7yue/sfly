import { cn } from "cn";
import type * as React from "react";

/** 多行输入框，样式与 Input 一致（sunk 底，聚焦时青色描边 + 光晕）。 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"min-h-16 w-full min-w-0 resize-y rounded-md border border-border bg-sunk px-2.25 py-1.5 text-sm text-fg-1 transition-colors outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_3px_var(--signal-soft)] disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-danger",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
