import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-7.5 w-full min-w-0 rounded-md border border-border bg-sunk px-2.25 text-sm text-fg-1 transition-colors outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_3px_var(--signal-soft)] disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-danger",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
