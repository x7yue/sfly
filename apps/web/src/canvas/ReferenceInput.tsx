// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import type { ReferenceOption } from "@sfly/orchestration";
import { useId, useRef, useState } from "react";

/** 光标前正在输入的引用：`${{` 之后、还没有闭合的部分。 */
const OPEN_REFERENCE = /\$\{\{\s*([\w.-]*)$/;

/**
 * 可以写引用的文本输入：输入 `${{` 时弹出补全，也可以点「引用」按钮插入。
 * 补全项只有本链的入口参数和本链上前面节点已声明的输出键（@sfly/orchestration 的 referenceOptions）。
 */
export function ReferenceInput({
	value,
	options,
	onChange,
	label,
	placeholder,
	invalid,
}: {
	value: string;
	options: ReferenceOption[];
	onChange(value: string): void;
	label: string;
	placeholder?: string;
	invalid?: boolean;
}) {
	const ref = useRef<HTMLInputElement>(null);
	const listId = useId();
	/** 补全的触发位置：null 表示关闭；start 是要被替换的起点（`${{` 的位置，按钮触发时是光标）。 */
	const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = useState(0);

	const matches = open
		? options.filter((o) => o.expression.toLowerCase().includes(open.query.toLowerCase()))
		: [];

	const detect = (text: string, caret: number) => {
		const m = OPEN_REFERENCE.exec(text.slice(0, caret));
		setOpen(m ? { start: caret - m[0].length, query: m[1] ?? "" } : null);
		setActive(0);
	};

	const choose = (option: ReferenceOption) => {
		const input = ref.current;
		const caret = input?.selectionStart ?? value.length;
		const start = open?.start ?? caret;
		const next = value.slice(0, start) + option.text + value.slice(caret);
		onChange(next);
		setOpen(null);
		requestAnimationFrame(() => {
			const pos = start + option.text.length;
			input?.focus();
			input?.setSelectionRange(pos, pos);
		});
	};

	return (
		<div className="relative flex gap-1">
			<input
				ref={ref}
				aria-label={label}
				role="combobox"
				aria-expanded={open !== null && matches.length > 0}
				aria-controls={listId}
				aria-autocomplete="list"
				className={`sf-inp sf-inp--mono ${invalid ? "sf-inp--bad" : ""}`}
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				onChange={(e) => {
					onChange(e.target.value);
					detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
				}}
				onKeyDown={(e) => {
					if (!open || matches.length === 0) return;
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						const delta = e.key === "ArrowDown" ? 1 : -1;
						setActive((a) => (a + delta + matches.length) % matches.length);
					} else if (e.key === "Enter" || e.key === "Tab") {
						e.preventDefault();
						choose(matches[active] as ReferenceOption);
					} else if (e.key === "Escape") {
						setOpen(null);
					}
				}}
				onBlur={() => setTimeout(() => setOpen(null), 150)}
			/>
			<button
				type="button"
				className="sf-btn sf-btn--ghost sf-btn--sm shrink-0"
				style={{ height: 32 }}
				title="插入引用"
				aria-label={`${label}：插入引用`}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => {
					ref.current?.focus();
					const caret = ref.current?.selectionStart ?? value.length;
					setOpen(open ? null : { start: caret, query: "" });
					setActive(0);
				}}
			>
				{"${}"}
			</button>
			{open && (
				<div className="sf-pop" id={listId} role="listbox" aria-label="可引用的值">
					{matches.length === 0 ? (
						<h6>
							{options.length === 0 ? "本链上没有可引用的参数或前面节点的输出" : "没有匹配的引用"}
						</h6>
					) : (
						<>
							<h6>本链入口参数 · 前面节点的输出</h6>
							{matches.map((o, i) => (
								<button
									type="button"
									key={o.expression}
									role="option"
									aria-selected={i === active}
									className="sf-it"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => choose(o)}
								>
									<span className="truncate">{o.expression}</span>
									<small>{o.kind === "param" ? "参数" : `节点 ${o.node_id}`}</small>
								</button>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}
