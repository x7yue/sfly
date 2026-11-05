import { useEffect, useRef, useState } from "react";
import { SEARCH_DEBOUNCE_MS } from "./polling";

/**
 * 列表页的搜索框（场景列表、运行记录共用）：关键字是地址里的查询参数，输入先存在本地，
 * 停止输入 {@link SEARCH_DEBOUNCE_MS} 后去掉首尾空白写进地址（`commit`，空串写 undefined）。
 * 地址里的关键字在别处被改掉或清掉（导航、「清除筛选」）时，搜索框跟着变，不会把旧值写回。
 *
 * 用法：`const box = useSearchInput(search.q, (q) => update({ q }))`，
 * `<Input value={box.value} onChange={(e) => box.onChange(e.target.value)} />`。
 */
export function useSearchInput(
	value: string | undefined,
	commit: (value: string | undefined) => void,
): { value: string; onChange: (text: string) => void } {
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

	return {
		value: text,
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
