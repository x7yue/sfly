import { useEffect, useRef } from "react";
import { notify } from "#/components/feedback/notify";

/**
 * 一条带「撤销」（或「还原」）的通知，说的是画布上刚做完的那一步（删除节点、整理布局）。之后又有了别的修改、
 * 或者撤销、重做过（`version` 变了），它说的那一步就不是撤销栈顶上的那一步了：点「撤销」撤掉的会是别的修改，
 * 所以这时收起它。同一时刻只留最新的一条。
 *
 * `version` 是 `useEditHistory` 的 `version`（每记一步、撤销、重做都会变）。`show` 里创建通知并返回它的 id。
 */
export function useUndoNotice(version: number) {
	const current = useRef<{ id: string | number; version: number | null } | null>(null);
	useEffect(() => {
		const notice = current.current;
		if (!notice) return;
		// 通知是在这一步的事件里创建的，那时撤销栈的版本还没更新：第一次渲染之后记下这一步的版本。
		if (notice.version === null) notice.version = version;
		else if (notice.version !== version) {
			notify.dismiss(notice.id);
			current.current = null;
		}
	}, [version]);
	return {
		show(create: () => string | number) {
			if (current.current) notify.dismiss(current.current.id);
			current.current = { id: create(), version: null };
		},
	};
}
