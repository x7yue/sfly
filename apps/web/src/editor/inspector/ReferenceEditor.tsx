import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Extension, Prec, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder } from "@codemirror/view";
import { cn } from "cn";
import { BracesIcon } from "lucide-react";
import {
	type CSSProperties,
	type Ref,
	type RefObject,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { ACTION } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { ReferenceList } from "./ReferenceList";
import {
	completionGroups,
	type InlineTrigger,
	initialActive,
	inlineTrigger,
	moveActive,
	type ReferenceChoice,
	referenceRanges,
} from "./reference-completion";

/**
 * 可以写引用的文本输入框（CodeMirror 6 内核）：文字和 `${{ … }}` 引用混写，值就是输入框里的文本。
 *
 * - 输入 `$`（或 `${`、`${{`）弹出引用补全，`insertReference()` 弹出同样的补全；选中后插入在光标处。
 *   输入触发的补全不预选（`$HOME` 后按 Enter 不会误插入引用），用方向键或鼠标选中后 Enter / Tab 才插入；
 *   `insertReference()` 触发的预选第一项。choices 为 null 的字段不能写引用，不弹补全。
 * - 文本里的引用高亮成一块，光标不会停在中间，退格一次整块删除。
 * - 高度随内容在 minLines 到 maxLines 行之间变化，超过后内部滚动；长行自动换行。
 * - 没有「模式」：显示什么完全由 value 决定；只有用户的编辑才调用 onChange。
 * - value 从外面变了（撤销、切换节点）时整个编辑状态换新，输入框自己的撤销历史随之清空。
 *
 * 外观与 `ui/input` 一致。CodeMirror 的样式规则不受 Tailwind 工具类控制，编辑器内部的样式都写在
 * 下面的 theme 里（只引用设计 token）。
 */
export function ReferenceEditor({
	ref,
	id,
	label,
	value,
	choices,
	placeholder: placeholderText,
	invalid = false,
	minLines = 1,
	maxLines = 8,
	className,
	onChange,
}: {
	ref?: Ref<ReferenceEditorHandle>;
	id?: string;
	/** 无障碍名称。 */
	label: string;
	/** 文档里的值：纯文本，引用写作 `${{ 表达式 }}`。 */
	value: string;
	/** 可以引用的值（reference-completion 的 referenceChoices）；null：这个字段不能写引用，不弹补全。 */
	choices: readonly ReferenceChoice[] | null;
	placeholder?: string;
	/** 显示为出错（红色描边、aria-invalid）。 */
	invalid?: boolean;
	minLines?: number;
	maxLines?: number;
	/** 加在外框上（字体、字号等）。 */
	className?: string;
	onChange(value: string): void;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const listId = useId();
	const [open, setOpen] = useState<Trigger | null>(null);
	/** 用户用方向键选中的项；null：还没选过，用补全打开时的预选（initialActive）。 */
	const [picked, setPicked] = useState<number | null>(null);

	const { groups, ordered } = useMemo(
		() => (open && choices ? completionGroups(choices, open.query) : { groups: [], ordered: [] }),
		[choices, open],
	);
	const active = picked ?? (open ? initialActive(open) : -1);
	// 只写了一个 $ 加文字（如 $HOME）又没有匹配的引用：多半不是在写引用，不打扰。
	const shown =
		choices !== null && open !== null && (open.braced || open.query === "" || ordered.length > 0);

	const dynamic = useMemo<Extension>(
		() => [
			EditorView.contentAttributes.of({
				...(id ? { id } : {}),
				role: "combobox",
				"aria-label": label,
				"aria-haspopup": "listbox",
				"aria-autocomplete": "list",
				"aria-expanded": String(shown),
				"aria-controls": listId,
				...(invalid ? { "aria-invalid": "true" } : {}),
			}),
			placeholderText ? placeholder(placeholderText) : [],
		],
		[id, label, invalid, placeholderText, shown, listId],
	);

	// CodeMirror 的扩展只在挂载时建一次，回调通过这个 ref 读到最新的 props 与状态。
	const live = useRef({ open: shown ? open : null, ordered, active, onChange, dynamic });
	live.current = { open: shown ? open : null, ordered, active, onChange, dynamic };

	/** 已经交给 onChange、value 还没跟上的文本：连续输入时 value 会滞后一两次渲染，不能当成外部修改。 */
	const emitted = useRef<string[]>([]);

	const [editor] = useState(() => {
		// 不能写引用的字段（choices 为 null，挂载后不变）里 `${{ … }}` 只是普通文字，不高亮。
		const referable = choices !== null;
		const compartment = new Compartment();
		const choose = (view: EditorView, trigger: Trigger, choice: ReferenceChoice) => {
			const head = view.state.selection.main.head;
			view.dispatch({
				changes: { from: trigger.start, to: head, insert: choice.text },
				selection: { anchor: trigger.start + choice.text.length },
				userEvent: "input.complete",
				scrollIntoView: true,
			});
			view.focus();
		};
		const completionKeys = EditorView.domEventHandlers({
			keydown(event, view) {
				const { open, ordered, active } = live.current;
				if (!open || event.isComposing) return false;
				if (event.key === "Escape") {
					// 只关掉补全：不让外层（检查器、弹窗）把这次 Esc 当成离开。
					event.preventDefault();
					event.stopPropagation();
					setOpen(null);
					return true;
				}
				if (ordered.length === 0) return false;
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					setPicked(moveActive(active, event.key === "ArrowDown" ? 1 : -1, ordered.length));
					return true;
				}
				if (event.key === "Enter" || event.key === "Tab") {
					// 没有选中项（输入 $ 触发、还没按过方向键）：按键照常换行 / 移走焦点。
					const choice = ordered[active];
					if (!choice) return false;
					event.preventDefault();
					choose(view, open, choice);
					return true;
				}
				return false;
			},
		});
		const listener = EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				const text = update.state.doc.toString();
				emitted.current.push(text);
				live.current.onChange(text);
			}
			if (update.focusChanged && !update.view.hasFocus) {
				setOpen(null);
			} else if (update.docChanged || update.selectionSet) {
				setOpen((previous) => nextTrigger(previous, update.state, update.docChanged));
				if (update.docChanged) setPicked(null);
			}
		});
		const base: Extension = [
			Prec.highest(completionKeys),
			history(),
			keymap.of([...standardKeymap, ...historyKeymap]),
			EditorView.lineWrapping,
			referable ? referenceMarks : [],
			theme,
			listener,
		];
		return {
			compartment,
			choose,
			state: (doc: string) =>
				EditorState.create({ doc, extensions: [base, compartment.of(live.current.dynamic)] }),
		};
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时建编辑器，之后的 value 由下面的 effect 同步
	useEffect(() => {
		const view = new EditorView({ parent: parent.current as HTMLDivElement });
		view.setState(editor.state(value));
		viewRef.current = view;
		return () => {
			viewRef.current = null;
			view.destroy();
		};
	}, [editor]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() === value) {
			emitted.current = [];
			return;
		}
		const index = emitted.current.indexOf(value);
		if (index >= 0) {
			emitted.current.splice(0, index + 1);
			return;
		}
		emitted.current = [];
		view.setState(editor.state(value));
		setOpen(null);
	}, [editor, value]);

	useEffect(() => {
		viewRef.current?.dispatch({ effects: editor.compartment.reconfigure(dynamic) });
	}, [editor, dynamic]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => viewRef.current?.focus(),
			insertReference() {
				const view = viewRef.current;
				if (!view) return;
				const start = view.state.selection.main.to;
				view.focus();
				view.dispatch({ selection: { anchor: start }, scrollIntoView: true });
				setOpen({ start, query: "", braced: true, manual: true });
				setPicked(null);
			},
		}),
		[],
	);

	return (
		<div className="relative">
			<div
				ref={parent}
				data-slot="reference-editor"
				data-invalid={invalid || undefined}
				style={
					{
						"--reference-editor-min-lines": minLines,
						"--reference-editor-max-lines": maxLines,
					} as CSSProperties
				}
				className={cn(
					"w-full min-w-0 cursor-text overflow-hidden rounded-md border border-border bg-sunk font-mono text-xs text-fg-1 transition-colors focus-within:border-signal focus-within:shadow-[0_0_0_3px_var(--signal-soft)] data-invalid:border-danger",
					className,
				)}
			/>
			{shown && open && choices && (
				<ReferenceList
					id={listId}
					className="top-full mt-1"
					choices={choices}
					groups={groups}
					ordered={ordered}
					active={active}
					onChoose={(choice) => {
						if (viewRef.current) editor.choose(viewRef.current, open, choice);
					}}
				/>
			)}
		</div>
	);
}

/** 从外面操作 ReferenceEditor（「插入引用」按钮、打开时聚焦）。 */
export interface ReferenceEditorHandle {
	focus(): void;
	/** 聚焦并在光标处弹出引用补全。 */
	insertReference(): void;
}

/** 输入框旁的「插入引用」按钮：点它弹出与输入 `$` 相同的补全。name 是字段名，用在无障碍名称里。 */
export function InsertReferenceButton({
	name,
	editor,
}: {
	name: string;
	editor: RefObject<ReferenceEditorHandle | null>;
}) {
	return (
		<Button
			variant="ghost"
			size="icon"
			className="flex-none"
			aria-label={`在 ${name} 中${ACTION.insertReference}`}
			title={ACTION.insertReference}
			// 不抢走输入框的焦点：光标留在原处，引用就插在那里。
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => editor.current?.insertReference()}
		>
			<BracesIcon />
		</Button>
	);
}

/** 补全的触发位置；manual 表示由「插入引用」打开（光标前没有 `$`）。 */
interface Trigger extends InlineTrigger {
	manual: boolean;
}

/** 编辑或移动光标之后补全应该处于的状态。typed：文本变了（只移动光标不会打开补全）。 */
function nextTrigger(previous: Trigger | null, state: EditorState, typed: boolean): Trigger | null {
	const selection = state.selection.main;
	if (!selection.empty) return null;
	const head = selection.head;
	if (previous?.manual && head >= previous.start) {
		const query = state.sliceDoc(previous.start, head);
		if (/^[\w.-]*$/.test(query)) return { ...previous, query };
	}
	if (!previous && !typed) return null;
	const line = state.doc.lineAt(head);
	const trigger = inlineTrigger(line.text.slice(0, head - line.from));
	return trigger ? { ...trigger, start: line.from + trigger.start, manual: false } : null;
}

const referenceMark = Decoration.mark({
	class: "cm-reference",
	attributes: { "data-reference": "" },
});

const marksOf = (text: string): DecorationSet =>
	Decoration.set(referenceRanges(text).map(({ from, to }) => referenceMark.range(from, to)));

/** 引用的高亮；同时是原子范围：光标跳过整块，退格 / Delete 整块删除。 */
const referenceMarks = StateField.define<DecorationSet>({
	create: (state) => marksOf(state.doc.toString()),
	update: (marks, tr) => (tr.docChanged ? marksOf(tr.newDoc.toString()) : marks),
	provide: (field) => [
		EditorView.decorations.from(field),
		EditorView.atomicRanges.of((view) => view.state.field(field)),
	],
});

/** 上下内边距之和：一行时总高 30px（与 ui/input 相同）。 */
const PADDING_Y = "10px";

const theme = EditorView.theme(
	{
		"&": { backgroundColor: "transparent", color: "inherit" },
		// 焦点由外框的青色描边 + 光晕表示（与 ui/input 一致）。
		"&.cm-focused": { outline: "none" },
		".cm-scroller": {
			fontFamily: "inherit",
			lineHeight: "inherit",
			minHeight: `calc(var(--reference-editor-min-lines) * 1lh + ${PADDING_Y})`,
			maxHeight: `calc(var(--reference-editor-max-lines) * 1lh + ${PADDING_Y})`,
		},
		// 内容区撑满最小高度：多行的输入框里，点在文字下面的空白处也能把光标放进去。
		".cm-content": {
			boxSizing: "border-box",
			minHeight: `calc(var(--reference-editor-min-lines) * 1lh + ${PADDING_Y})`,
			padding: "5px 0",
			caretColor: "var(--fg-1)",
		},
		".cm-line": { padding: "0 9px" },
		".cm-placeholder": { color: "var(--fg-3)" },
		".cm-reference": {
			borderRadius: "var(--radius-sm)",
			backgroundColor: "var(--raised-2)",
			boxShadow: "0 0 0 1px var(--border-strong)",
		},
	},
	{ dark: true },
);
