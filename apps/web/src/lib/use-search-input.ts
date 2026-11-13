import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { focusFirstListItem } from "#/components/list-navigation";
import { useShortcut } from "#/components/shortcuts";
import { SEARCH_DEBOUNCE_MS } from "./polling";

/**
 * 列表页的搜索框（场景列表、运行记录共用）：关键字是地址里的查询参数，输入先存在本地，
 * 停止输入 {@link SEARCH_DEBOUNCE_MS} 后去掉首尾空白写进地址（`commit`，空串写 undefined）。
 * 地址里的关键字在别处被改掉或清掉（导航、「清除筛选」）时，搜索框跟着变，不会把旧值写回。
 *
 * 用法：`const box = useSearchInput(search.q, (q) => update({ q }))`，
 * `<Input ref={box.ref} value={box.value} onChange={(e) => box.onChange(e.target.value)} onKeyDown={box.onKeyDown} />`。
 * `ref` 与 `onKeyDown` 接上列表页的键盘操作：`/` 聚焦并选中搜索框的文字，搜索框里按 ↓ 进入列表的第一项。
 */
export function useSearchInput(
	value: string | undefined,
	commit: (value: string | undefined) => void,
): {
	value: string;
	onChange: (text: string) => void;
	ref: RefObject<HTMLInputElement | null>;
	onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
} {
	const [text, setText] = useState(value ?? "");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** 最近一次写进地址（或从地址同步来）的值。 */
	const committed = useRef(value);
	const commitRef = useRef(commit);
	commitRef.current = commit;

	useEffect(() => {
		if (value === committed.current) return;
		committed.current = value;
		clearTimeout(timer.current);
		setText(value ?? "");
	}, [value]);
	useEffect(() => () => clearTimeout(timer.current), []);

	const ref = useRef<HTMLInputElement>(null);
	useShortcut("list-search", () => {
		ref.current?.focus();
		ref.current?.select();
	});

	return {
		value: text,
		ref,
		onKeyDown(event) {
			if (event.key === "ArrowDown" && focusFirstListItem()) event.preventDefault();
		},
		onChange(next) {
			setText(next);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				const trimmed = next.trim() || undefined;
				if (trimmed === committed.current) return;
				committed.current = trimmed;
				commitRef.current(trimmed);
			}, SEARCH_DEBOUNCE_MS);
		},
	};
}
