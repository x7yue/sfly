import { cn } from "cn";
import { useId } from "react";

/**
 * 表单字段：标签、控件、帮助文字、错误（docs/DESIGN-SYSTEM.md「表单与校验」）。错误与帮助用 `aria-describedby`
 * 关联到控件，出错时控件带 `aria-invalid`（红色描边）。控件由使用方渲染，把收到的属性原样传上去：
 *
 *   <FormField label="场景名称" required error={submitted ? nameError : undefined}>
 *     {(control) => <Input {...control} value={name} onChange={…} />}
 *   </FormField>
 *
 * 校验的时机：提交按钮只在提交进行中禁用，不用来拦校验；第一次提交前不显示错误，提交失败后把焦点放到第一个出错的
 * 字段，之后随输入更新错误。服务端返回的错误用 `FormAlert` 写在弹窗里，不发通知。
 */
export interface FieldControlProps {
	id: string;
	"aria-invalid": true | undefined;
	"aria-describedby": string | undefined;
	"aria-required": true | undefined;
}

export function FormField({
	label,
	required = false,
	help,
	error,
	className,
	children,
}: {
	label: React.ReactNode;
	/** 必填：标签后加一个中性的 *，控件带 aria-required。 */
	required?: boolean;
	help?: React.ReactNode;
	/** 已经该让用户看到的错误（第一次提交之前不传）。 */
	error?: string | undefined;
	className?: string;
	children: (control: FieldControlProps) => React.ReactNode;
}) {
	const id = useId();
	const helpId = `${id}-help`;
	const errorId = `${id}-error`;
	const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ");
	return (
		<div data-slot="form-field" className={cn("flex flex-col gap-1", className)}>
			<label htmlFor={id} className="text-xs text-fg-2">
				{label}
				{required && (
					<span aria-hidden className="ml-0.5 text-fg-3">
						*
					</span>
				)}
			</label>
			{children({
				id,
				"aria-invalid": error ? true : undefined,
				"aria-describedby": describedBy || undefined,
				"aria-required": required || undefined,
			})}
			{help && (
				<p id={helpId} className="m-0 text-xs text-fg-3">
					{help}
				</p>
			)}
			{error && (
				<p id={errorId} className="m-0 text-xs text-danger-fg">
					{error}
				</p>
			)}
		</div>
	);
}

/** 提交失败（服务端错误）：写在弹窗或表单里、提交按钮上方，出现时读屏读一次。 */
export function FormAlert({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<p role="alert" data-slot="form-alert" className={cn("m-0 text-sm text-danger-fg", className)}>
			{children}
		</p>
	);
}
