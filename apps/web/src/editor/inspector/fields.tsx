import type { ReactNode } from "react";

/**
 * 检查器里的一个字段（原型 `.field`）：左列名称（必填星号、类型），右列控件、错误与说明。
 * `aside` 放在控件右侧（「插入引用」「放大编辑」按钮）。
 */
export function Field({
	label,
	htmlFor,
	required,
	type,
	error,
	help,
	aside,
	children,
}: {
	label: ReactNode;
	htmlFor?: string;
	required?: boolean;
	type?: string;
	error?: ReactNode;
	help?: ReactNode;
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="mb-3 grid grid-cols-[96px_1fr] items-start gap-x-2.5 gap-y-1.5">
			<label htmlFor={htmlFor} className="min-w-0 truncate pt-1.5 text-sm text-fg-2">
				{label}
				{required && <span className="ml-0.5 text-fg-2">*</span>}
				{type && <span className="block font-mono text-2xs text-fg-3">{type}</span>}
			</label>
			<div className="relative flex min-w-0 flex-col gap-1.25">
				<div className="flex min-w-0 gap-1.5">
					<div className="min-w-0 flex-1">{children}</div>
					{aside}
				</div>
				{error && <p className="m-0 text-xs text-danger-fg">{error}</p>}
				{help && <p className="m-0 text-xs text-fg-3">{help}</p>}
			</div>
		</div>
	);
}

/** 检查器里的小节标题（原型 `.sec-h`）。 */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<h3 className="mt-4 mb-2 flex items-center gap-2 text-xs font-medium text-fg-3 first:mt-0">
			{children}
			{aside && <span className="ml-auto font-normal">{aside}</span>}
		</h3>
	);
}
