import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * 输入框里还没生效的值：例如整数输入填了 abc、JSON 写了一半。这种值不能写进文档，
 * 但在用户改正之前要一直显示在输入框里（切换节点、页签后也不丢）并阻止保存。
 * 按 `节点 ID/字段` 记在编辑器里；值合法后清除，删除节点时一并清除。
 */
export interface FieldDraft {
	text: string;
	error: string;
}

interface FieldDraftsValue {
	drafts: ReadonlyMap<string, FieldDraft>;
	set(key: string, draft: FieldDraft | null): void;
	/** 清掉以 prefix 开头的全部草稿（删除节点、删除参数时）。 */
	clear(prefix: string): void;
}

const FieldDraftsContext = createContext<FieldDraftsValue>({
	drafts: new Map(),
	set: () => {},
	clear: () => {},
});

export const draftKey = (nodeId: string, field: string) => `${nodeId}/${field}`;

export function useFieldDraftStore() {
	const [drafts, setDrafts] = useState<ReadonlyMap<string, FieldDraft>>(new Map());
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
	}, []);
	const value = useMemo(() => ({ drafts, set, clear }), [drafts, set, clear]);
	return { value, drafts, clear };
}

export const FieldDraftsProvider = FieldDraftsContext.Provider;

export const useClearFieldDrafts = () => useContext(FieldDraftsContext).clear;

/** 丢掉某一个字段的草稿（字段的值被别的途径整个换掉时，例如选了一个引用）。 */
export function useDropFieldDraft() {
	const { set } = useContext(FieldDraftsContext);
	return useCallback((key: string) => set(key, null), [set]);
}

/** 某个字段还没生效的输入的错误。 */
export const useFieldDraftError = (key: string) =>
	useContext(FieldDraftsContext).drafts.get(key)?.error;

/**
 * 一个需要解析的输入框：返回显示的文本与错误，以及输入时调用的 `change`。
 * `parse` 返回 `{ value }` 表示合法（写进文档），返回 `{ error }` 表示不合法（只记草稿）。
 * 文档里的值被别处改了（例如「常用值」按钮）且没有草稿时，输入框跟着显示新值；
 * 自己输入的合法值不会被重新格式化（输入 `1.` 时不会被改成 `1`）。
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
	const { drafts, set } = useContext(FieldDraftsContext);
	const draft = drafts.get(key);
	const formatted = format(value);
	const [text, setText] = useState(draft?.text ?? formatted);
	const [synced, setSynced] = useState(formatted);
	if (formatted !== synced) {
		setSynced(formatted);
		if (!draft) setText(formatted);
	}
	const change = (raw: string) => {
		setText(raw);
		const result = parse(raw);
		if ("error" in result) {
			set(key, { text: raw, error: result.error });
			return;
		}
		set(key, null);
		setSynced(format(result.value));
		onChange(result.value);
	};
	return { text, error: draft?.error, change };
}
