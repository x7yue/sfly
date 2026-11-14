import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";

/**
 * 原生下拉（shadcn/ui base-nova 拉取后按设计体系改写，外观同 Input）。原生 select 不是模态浮层：
 * 打开时不锁定页面滚动、不拦截画布的缩放与拖拽，所以画布上的检查器里用它而不是 Base UI Select。
 */
function NativeSelect({
	className,
	...props
}: Omit<React.ComponentProps<"select">, "size"> & { className?: string }) {
	return (
		<div
			data-slot="native-select-wrapper"
			className={cn("relative w-full has-[select:disabled]:opacity-40", className)}
		>
			<select
				data-slot="native-select"
				className="h-7.5 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-border-control bg-sunk pr-7 pl-2.25 text-sm text-fg-1 transition-colors outline-none focus:border-signal focus:outline-hidden focus:focus-glow disabled:cursor-not-allowed aria-invalid:border-danger"
				{...props}
			/>
			<ChevronDownIcon
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-fg-3"
			/>
		</div>
	);
}

function NativeSelectOption(props: React.ComponentProps<"option">) {
	return <option data-slot="native-select-option" className="bg-raised text-fg-1" {...props} />;
}

export { NativeSelect, NativeSelectOption };
