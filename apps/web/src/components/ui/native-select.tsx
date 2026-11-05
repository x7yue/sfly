import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";

/** 原生下拉选择（键盘与读屏行为由浏览器提供），外观与 Input 一致；用于工具栏里的简单筛选。 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
	return (
		<span className={cn("relative inline-flex", className)}>
			<select
				data-slot="native-select"
				className="h-7.5 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-border bg-sunk pr-7 pl-2.25 text-sm text-fg-1 outline-none focus:border-signal focus:shadow-[0_0_0_3px_var(--signal-soft)] disabled:cursor-not-allowed disabled:opacity-40"
				{...props}
			/>
			<ChevronDownIcon
				aria-hidden
				className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-fg-3"
			/>
		</span>
	);
}

export { NativeSelect };
