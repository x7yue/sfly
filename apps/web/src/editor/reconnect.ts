import { reconnectEdge } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import type { Connection } from "@xyflow/react";
import { type RefObject, useMemo, useRef } from "react";
import { type DocEdge, docEdgeOf, type SfEdge } from "#/components/canvas/flow";
import { notify } from "#/components/feedback/notify";

/**
 * 拖动连线的端点改接（#185）：React Flow 的重连手势 → @sfly/orchestration 的 reconnectEdge（一次改接一步撤销）。
 *
 * 改接过程中判断目标端口能不能接（isValidConnection）和松开后的拒绝原因，都要按改接的规则——原来那条连线不算，
 * 所以编辑器的连线检查先问 `problem`：正在改接时返回 null（可以接）或拒绝原因，没有在改接时返回 undefined。
 * 被拒绝或松开在空白处时 React Flow 不调用 onReconnect，连线留在原处；`active` 时编辑器的 onConnectEnd
 * 只提示拒绝原因，不弹添加节点菜单。
 */
export function useReconnect(
	docRef: RefObject<OrchestrationDocument>,
	apply: (doc: OrchestrationDocument) => void,
) {
	/** 正在改接的连线（从按下端点到松开）。 */
	const active = useRef<DocEdge | null>(null);
	const applyRef = useRef(apply);
	applyRef.current = apply;
	return useMemo(
		() => ({
			active,
			problem(next: DocEdge): string | null | undefined {
				const edge = active.current;
				if (!edge) return undefined;
				const edit = reconnectEdge(docRef.current, edge, next);
				return edit.ok ? null : edit.reason;
			},
			handlers: {
				onReconnectStart: (_event: unknown, edge: SfEdge) => {
					active.current = docEdgeOf(edge);
				},
				onReconnect: (old: SfEdge, connection: Connection) => {
					const doc = docRef.current;
					const edit = reconnectEdge(doc, docEdgeOf(old), {
						from: connection.source,
						to: connection.target,
					});
					if (!edit.ok) notify.warning(edit.reason);
					else if (edit.doc !== doc) applyRef.current(edit.doc);
				},
				onReconnectEnd: () => {
					active.current = null;
				},
			},
		}),
		[docRef],
	);
}
