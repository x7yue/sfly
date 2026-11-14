import { cn } from "cn";
import { Fragment, type ReactNode, useId } from "react";
import type { FieldControlProps } from "@/components/ui/form-field";
import { useTouchFields } from "../field-drafts";

/**
 * 检查器里一组字段的容器：所有字段共用三条轨道（名称、控件、右侧按钮），有按钮的字段的控件右沿因此对齐。
 * 字段本身是子网格（subgrid），所以必须是它的直接子元素；其余子元素（小节标题、说明、警告）占满整行。
 * 直接把这组类名放在页签面板上，或者用 `FieldList`。
 */
export const FIELD_LIST_CLASS =
	"grid grid-cols-[fit-content(40%)_minmax(0,1fr)_auto] content-start [&>*]:col-span-full";

export function FieldList({ className, children }: { className?: string; children: ReactNode }) {
	return <div className={cn(FIELD_LIST_CLASS, className)}>{children}</div>;
}

/** 交给字段里控件的属性（与 `FormField` 的一致）；`data-field-key` 让保存被拦下时找到出错的输入框。 */
export type FieldControl = FieldControlProps & { "data-field-key"?: string | undefined };

/** 名称末尾这几个字符与必填星号绑在一起不折行，折行时星号不会落单。 */
const CHARS_KEPT_WITH_STAR = 3;

function Breakable({ text }: { text: string }) {
	let offset = 0;
	return text.split(/(?<=[_.-])/).map((part) => {
		const start = offset;
		offset += part.length;
		return (
			<Fragment key={start}>
				{start > 0 && <wbr />}
				{part}
			</Fragment>
		);
	});
}

function LabelText({ text, required }: { text: string; required: boolean | undefined }) {
	const head = text.slice(0, -CHARS_KEPT_WITH_STAR);
	const tail = text.slice(-CHARS_KEPT_WITH_STAR);
	return (
		<>
			<Breakable text={head} />
			<span className="whitespace-nowrap">
				{tail}
				{required && <span className="ml-0.5 text-fg-2">*</span>}
			</span>
		</>
	);
}

/**
 * 检查器里的一个字段（原型 `.field`）：左列名称（必填星号、类型），中列控件，右列按钮（`aside`），
 * 控件下面是错误与说明。必须放在 `FieldList` 里。
 *
 * 控件由使用方渲染，把收到的属性原样传上去：
 *
 *   <Field label="timeout" error={error} help="…">
 *     {(control) => <Input {...control} value={…} />}
 *   </Field>
 *
 * 名称元素的 id 是 `${control.id}-label`（控件自己没有 aria-label 时用 `aria-labelledby` 指过来，例如开关）。
 * `error` 只传要给用户看的错误：输入到一半的错误等字段交互过再给（field-drafts.tsx）。
 * `id` 默认自动生成；使用方要在别处找到控件时自己传。
 */
export function Field({
	label,
	mono,
	required,
	type,
	error,
	help,
	aside,
	id: given,
	fieldKey,
	children,
}: {
	label: string;
	mono?: boolean;
	required?: boolean;
	type?: string;
	error?: ReactNode;
	help?: ReactNode;
	aside?: ReactNode;
	id?: string;
	fieldKey?: string;
	children: ReactNode | ((control: FieldControl) => ReactNode);
}) {
	const generated = useId();
	const touch = useTouchFields();
	const id = given ?? generated;
	const errorId = `${id}-error`;
	const helpId = `${id}-help`;
	const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ");
	const control: FieldControl = {
		id,
		"aria-invalid": error ? true : undefined,
		"aria-describedby": describedBy || undefined,
		"aria-required": required || undefined,
		"data-field-key": fieldKey,
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 只记录里面的控件失焦（字段交互过，错误可以显示了），元素本身不可操作
		<div
			data-slot="field"
			onBlur={fieldKey ? () => touch(fieldKey) : undefined}
			className="relative mb-3 grid grid-cols-subgrid items-start gap-y-1.25"
		>
			<label
				id={`${id}-label`}
				htmlFor={id}
				className={cn(
					"row-span-2 min-w-0 pt-1.5 pr-2.5 text-sm wrap-anywhere text-fg-2",
					mono && "font-mono",
				)}
			>
				<LabelText text={label} required={required} />
				{/* 类型说明最多撑到 96px：它不该把名称列撑宽、把控件挤窄 */}
				{type && <span className="block max-w-24 font-mono text-2xs text-fg-3">{type}</span>}
			</label>
			<div className={cn("min-w-0", !aside && "col-span-2")}>
				{typeof children === "function" ? children(control) : children}
			</div>
			{aside && <div className="flex gap-1.5 pl-1.5">{aside}</div>}
			{(error || help) && (
				<div className="col-start-2 col-end-4 flex min-w-0 flex-col gap-1.25">
					{error && (
						<p id={errorId} className="m-0 text-xs text-danger-fg">
							{error}
						</p>
					)}
					{help && (
						<p id={helpId} className="m-0 text-xs wrap-anywhere whitespace-pre-line text-fg-3">
							{help}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/** 把焦点放到某个字段的控件上。字段所在的节点和页签可能刚刚才渲染，找不到时等几帧再找；返回取消函数。 */
export function focusField(key: string): () => void {
	let frame = 0;
	let tries = 0;
	const tick = () => {
		const el = document.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(key)}"]`);
		if (el) {
			el.focus();
		} else if (++tries < 20) {
			frame = requestAnimationFrame(tick);
		}
	};
	frame = requestAnimationFrame(tick);
	return () => cancelAnimationFrame(frame);
}

/** 检查器里的小节标题（原型 `.sec-h`）。 */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<h3 className="mt-4 mb-2 flex items-center gap-2 text-xs font-semibold text-fg-3 first:mt-0">
			{children}
			{aside && <span className="ml-auto font-normal">{aside}</span>}
		</h3>
	);
}
