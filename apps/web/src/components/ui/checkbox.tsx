import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import type * as React from "react";

/**
 * 勾选框：原生 `<input type="checkbox">`（label、表单提交、键盘操作都是浏览器自带的）换上设计体系的外观——
 * 16 × 16、`sunk` 底、控件描边；勾选后是中性高亮（`selected` 底、深色对勾，不用青色）。
 * 焦点环沿用全局青色 :focus-visible，禁用 40% 不透明。`ref` 与其余属性都给 input，`className` 给外层。
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
	return (
		<span
			data-slot="checkbox"
			className={cn("relative inline-grid size-4 flex-none place-items-center", className)}
		>
			<input
				type="checkbox"
				className="peer m-0 size-4 cursor-pointer appearance-none rounded-sm border border-border bg-sunk transition-colors hover:border-border-strong checked:border-selected checked:bg-selected disabled:cursor-not-allowed disabled:opacity-40"
				{...props}
			/>
			<CheckIcon
				aria-hidden
				strokeWidth={3}
				className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100 peer-disabled:opacity-40"
			/>
		</span>
	);
}

export { Checkbox };
