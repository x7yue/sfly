import type { ReactNode } from "react";

/** 底部面板页签里的一句说明（没有选中节点、节点还没开始、正在加载、没有内容）。 */
export function Hint({ children }: { children: ReactNode }) {
	return <p className="m-0 p-4 text-sm text-fg-3">{children}</p>;
}
