// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { type ReferenceOption, referenceText } from "@sfly/orchestration";
import { cn } from "cn";
import { type ReactNode, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** 一个引用补全项，带上来源说明（类型、所属节点）。 */
export interface ReferenceChoice extends ReferenceOption {
	detail: string;
}

/**
 * 检查器里的一个字段（原型 `.field`）：左列名称（必填星号、类型），右列控件、错误与说明。
 * `aside` 放在控件右侧（常量 / 引用切换）。
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
				{required && <span className="ml-0.5 text-danger-fg">*</span>}
				{type && <span className="block font-mono text-2xs text-fg-3">{type}</span>}
			</label>
			<div className="relative flex min-w-0 flex-col gap-1.25">
				<div className="flex min-w-0 gap-1.5">
					<div className="min-w-0 flex-1">{children}</div>
					{aside}
				</div>
				{error && <p className="m-0 text-2xs text-danger-fg">{error}</p>}
				{help && <p className="m-0 text-2xs text-fg-3">{help}</p>}
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

/** 分段切换（原型 `.seg`）。 */
export function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly (readonly [T, string])[];
	onChange(value: T): void;
}) {
	return (
		<fieldset
			aria-label={label}
			className="m-0 inline-flex h-7.5 flex-none gap-0.5 rounded-lg border border-border-soft bg-sunk p-0.5"
		>
			{options.map(([v, text]) => (
				<button
					key={v}
					type="button"
					aria-pressed={value === v}
					onClick={() => onChange(v)}
					className={cn(
						"cursor-pointer rounded-md px-2.5 text-xs whitespace-nowrap text-fg-2 hover:text-fg-1",
						value === v && "bg-raised-2 text-fg-1",
					)}
				>
					{text}
				</button>
			))}
		</fieldset>
	);
}

/** 光标前正在输入的引用：`${{` 之后、还没有闭合的部分。 */
const OPEN_REFERENCE = /\$\{\{\s*([\w.-]*)$/;
/** 整个值就是一个引用时的表达式。 */
export const wholeReference = (value: unknown): string | undefined =>
	typeof value === "string" ? /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value)?.[1] : undefined;

/**
 * 可以引用的文本输入，补全列表按「入口参数」「前序节点」分组（原型 refCombo）。
 *
 * - `whole`：引用模式，输入框里是引用表达式（`params.x`、`nodes.a.outputs.b`），聚焦即弹出补全，值保存为 `${{ 表达式 }}`；
 * - 否则是常量文本，输入 `${{` 时弹出补全，选中的引用插入到光标处。
 *
 * 补全列表是输入框下方的普通元素，不是模态浮层：打开时画布照常缩放、拖动，不锁定滚动。
 */
export function ReferenceTextInput({
	id,
	label,
	value,
	choices,
	whole = false,
	placeholder,
	invalid,
	onChange,
}: {
	id?: string;
	label: string;
	/** 文档里的值（whole 模式下是完整的 `${{ … }}`）。 */
	value: string;
	choices: ReferenceChoice[];
	whole?: boolean;
	placeholder?: string;
	invalid?: boolean;
	onChange(value: string): void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	const listId = useId();
	const text = whole ? (wholeReference(value) ?? value) : value;
	/** 补全的触发位置：null 表示关闭；start 是要被替换的起点。 */
	const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = useState(0);

	const query = (open?.query ?? "").toLowerCase();
	const matches = open ? choices.filter((c) => c.expression.toLowerCase().includes(query)) : [];
	const groups = [
		["入口参数", matches.filter((c) => c.kind === "param")],
		["前序节点", matches.filter((c) => c.kind === "output")],
	] as const;
	const ordered = [...groups[0][1], ...groups[1][1]];

	const detect = (raw: string, caret: number) => {
		if (whole) {
			setOpen({ start: 0, query: raw });
		} else {
			const m = OPEN_REFERENCE.exec(raw.slice(0, caret));
			setOpen(m ? { start: caret - m[0].length, query: m[1] ?? "" } : null);
		}
		setActive(0);
	};

	const choose = (choice: ReferenceChoice) => {
		setOpen(null);
		if (whole) {
			onChange(choice.text);
			return;
		}
		const input = ref.current;
		const caret = input?.selectionStart ?? value.length;
		const start = open?.start ?? caret;
		onChange(value.slice(0, start) + choice.text + value.slice(caret));
		requestAnimationFrame(() => {
			const pos = start + choice.text.length;
			input?.focus();
			input?.setSelectionRange(pos, pos);
		});
	};

	// 补全列表相对于外层 Field 的控件列定位（与整列同宽，不只是输入框那么窄）。
	return (
		<div>
			<Input
				ref={ref}
				id={id}
				aria-label={label}
				role="combobox"
				aria-expanded={open !== null}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-invalid={invalid || undefined}
				className="font-mono text-xs"
				value={text}
				placeholder={placeholder}
				spellCheck={false}
				autoComplete="off"
				onFocus={(e) => whole && detect(e.target.value, 0)}
				onChange={(e) => {
					const raw = e.target.value;
					onChange(whole ? (raw === "" ? "" : referenceText(raw)) : raw);
					detect(raw, e.target.selectionStart ?? raw.length);
				}}
				onKeyDown={(e) => {
					if (!open) return;
					if (e.key === "Escape") {
						// 只关掉补全，不让检查器把焦点送回画布。
						e.preventDefault();
						e.stopPropagation();
						setOpen(null);
						return;
					}
					if (ordered.length === 0) return;
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						const delta = e.key === "ArrowDown" ? 1 : -1;
						setActive((a) => (a + delta + ordered.length) % ordered.length);
					} else if (e.key === "Enter" || e.key === "Tab") {
						e.preventDefault();
						choose(ordered[active] as ReferenceChoice);
					}
				}}
				onBlur={() => setOpen(null)}
			/>
			{open && (
				<div
					id={listId}
					role="listbox"
					aria-label="可引用的值"
					className="absolute top-8.5 right-0 left-0 z-20 max-h-65 overflow-auto rounded-lg border border-border-strong bg-raised p-1 shadow-pop"
				>
					{ordered.length === 0 ? (
						<p className="m-0 px-2 py-1.5 text-xs text-fg-3">
							{choices.length === 0 ? "本链上没有可引用的参数或前序节点的输出" : "没有匹配的引用"}
						</p>
					) : (
						groups.map(
							([title, items]) =>
								items.length > 0 && (
									// biome-ignore lint/a11y/useSemanticElements: listbox 里的分组用 role=group
									<div key={title} role="group" aria-label={title}>
										<div className="px-2 pt-1.5 pb-0.75 text-2xs text-fg-3">{title}</div>
										{items.map((c) => {
											const index = ordered.indexOf(c);
											return (
												<div
													key={c.expression}
													role="option"
													tabIndex={-1}
													aria-selected={index === active}
													className={cn(
														"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-raised-2",
														index === active && "bg-raised-2",
													)}
													onMouseDown={(e) => e.preventDefault()}
													onClick={() => choose(c)}
													onKeyDown={() => {}}
												>
													<span className="min-w-0 flex-1 truncate font-mono" title={c.expression}>
														{c.expression}
													</span>
													<span className="flex-none text-2xs text-fg-3">{c.detail}</span>
												</div>
											);
										})}
									</div>
								),
						)
					)}
				</div>
			)}
		</div>
	);
}
