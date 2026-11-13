import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * 输入框里还没生效的值：例如整数输入填了 abc、JSON 写了一半。这种值不能写进文档，
 * 但在用户改正之前要一直显示在输入框里（切换节点、页签后也不丢）并阻止保存。
 * 按 `节点 ID/字段` 记在编辑器里；值合法后清除，删除节点时一并清除。
 *
 * 草稿是编辑状态的一部分：撤销 / 重做把节点、连线、场景设置和草稿一起换成同一个时刻的样子
 * （edit-history.ts 的 EditSnapshot），输入框跟着草稿走，不会留着撤销前的文字。
 *
 * 错误什么时候给用户看：输入到一半的文字多半还不是合法的值，边输入边报错只会打扰。字段第一次失焦、
 * 或保存被字段错误拦下之后，它才算「交互过」（touched），此后每次输入都立即校验，改对了立即消失。
 * 阻止保存的判断不看这个：没交互过的错误同样拦着保存，只是还没显示、也不计入顶栏的错误条数。
 */
export interface FieldDraft {
	text: string;
	error: string;
}

interface FieldStateValue {
	drafts: ReadonlyMap<string, FieldDraft>;
	touched: ReadonlySet<string>;
	set(key: string, draft: FieldDraft | null): void;
	/** 清掉以 prefix 开头的全部草稿与交互记录（删除节点、删除参数时）。 */
	clear(prefix: string): void;
	touch(keys: string | readonly string[]): void;
}

const FieldStateContext = createContext<FieldStateValue>({
	drafts: new Map(),
	touched: new Set(),
	set: () => {},
	clear: () => {},
	touch: () => {},
});

export const draftKey = (nodeId: string, field: string) => `${nodeId}/${field}`;

/** 字段错误对应的字段的键（场景级字段没有节点）。 */
export const fieldErrorKey = (error: { nodeId?: string | undefined; field: string }) =>
	draftKey(error.nodeId ?? "", error.field);

export function useFieldDraftStore() {
	const [drafts, setDrafts] = useState<ReadonlyMap<string, FieldDraft>>(new Map());
	const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
	const set = useCallback((key: string, draft: FieldDraft | null) => {
		setDrafts((current) => {
			if (!draft && !current.has(key)) return current;
			const next = new Map(current);
			if (draft) next.set(key, draft);
			else next.delete(key);
			return next;
		});
	}, []);
	const clear = useCallback((prefix: string) => {
		setDrafts((current) => {
			if (![...current.keys()].some((k) => k.startsWith(prefix))) return current;
			return new Map([...current].filter(([k]) => !k.startsWith(prefix)));
		});
		setTouched((current) => {
			if (![...current].some((k) => k.startsWith(prefix))) return current;
			return new Set([...current].filter((k) => !k.startsWith(prefix)));
		});
	}, []);
	const touch = useCallback((keys: string | readonly string[]) => {
		const list = typeof keys === "string" ? [keys] : keys;
		setTouched((current) => {
			if (list.every((k) => current.has(k))) return current;
			return new Set([...current, ...list]);
		});
	}, []);
	const value = useMemo(
		() => ({ drafts, touched, set, clear, touch }),
		[drafts, touched, set, clear, touch],
	);
	return { value, drafts, touched, replace: setDrafts, clear, touch };
}

export const FieldDraftsProvider = FieldStateContext.Provider;

export const useClearFieldDrafts = () => useContext(FieldStateContext).clear;

/** 丢掉某一个字段的草稿（字段的值被别的途径整个换掉时，例如选了一个引用）。 */
export function useDropFieldDraft() {
	const { set } = useContext(FieldStateContext);
	return useCallback((key: string) => set(key, null), [set]);
}

/** 标记字段交互过（失焦时调用）：一行里有多个字段、字段键由序号拼出来时用。 */
export const useTouchFields = () => useContext(FieldStateContext).touch;

/** 字段是不是已经交互过：交互过才显示它的错误。`touch` 在失焦时调用。 */
export function useFieldTouch(key: string) {
	const { touched, touch } = useContext(FieldStateContext);
	const touchKey = useCallback(() => touch(key), [touch, key]);
	return { touched: touched.has(key), touch: touchKey };
}

/** 要给用户看的字段错误：没生效的输入的错误（交互过才显示）在前，静态检查的警告（一直显示）在后。 */
export function useFieldErrors(key: string, problems: readonly string[]): string[] {
	const { drafts, touched } = useContext(FieldStateContext);
	const draft = drafts.get(key);
	return [...(draft && touched.has(key) ? [draft.error] : []), ...problems];
}

/**
 * 一个需要解析的输入框：返回显示的文本与错误，以及输入时调用的 `change`、失焦时调用的 `blur`。
 * `parse` 返回 `{ value }` 表示合法（写进文档），返回 `{ error }` 表示不合法（只记草稿）。
 * 有草稿时输入框显示草稿的文字，没有时显示最近一次合法的输入：文档里的值被别处改了（「常用值」按钮、撤销）
 * 就跟着显示新值；自己输入的合法值不会被重新格式化（输入 `1.` 时不会被改成 `1`）。
 */
export function useParsedField<T>({
	key,
	value,
	format,
	parse,
	onChange,
}: {
	key: string;
	value: T;
	format(value: T): string;
	parse(text: string): { value: T } | { error: string };
	onChange(value: T): void;
}) {
	const { drafts, touched, set, touch } = useContext(FieldStateContext);
	const draft = drafts.get(key);
	const formatted = format(value);
	const [typed, setTyped] = useState(formatted);
	const [synced, setSynced] = useState(formatted);
	if (formatted !== synced) {
		setSynced(formatted);
		setTyped(formatted);
	}
	const change = (raw: string) => {
		const result = parse(raw);
		if ("error" in result) {
			set(key, { text: raw, error: result.error });
			return;
		}
		setTyped(raw);
		set(key, null);
		setSynced(format(result.value));
		onChange(result.value);
	};
	return {
		text: draft?.text ?? typed,
		/** 草稿的错误，交互过才有。 */
		error: draft && touched.has(key) ? draft.error : undefined,
		change,
		blur: () => touch(key),
	};
}
