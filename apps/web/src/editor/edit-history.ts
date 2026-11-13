import type { EdgeChange, NodeChange } from "@xyflow/react";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import type { DocMeta, SfEdge, SfNode } from "#/components/canvas/flow";
import type { FieldDraft } from "./field-drafts";
import { UndoStack } from "./history";

/**
 * 撤销的单位：画布上的节点、连线、场景级设置（默认 Agent、包版本锁定），以及输入框里还没生效的草稿。
 * 草稿跟着快照走：撤销到某个时刻后，输入框、顶栏的检查结果和节点卡片说的是同一件事。
 */
export interface EditSnapshot {
	nodes: SfNode[];
	edges: SfEdge[];
	meta: DocMeta;
	drafts: ReadonlyMap<string, FieldDraft>;
}

/**
 * 编排画布的撤销 / 重做（#39）：所有修改场景的操作在修改前调用 `checkpoint`，记下修改前的快照。
 * 节点拖动、删除节点与连线经 `onNodesChange` / `onEdgesChange` 自动记录（一次拖动、一次删除各算一步）；
 * 同一时刻（同一个任务里）的多次 checkpoint 只记一步，例如删除节点时连带删除的连线。
 */
export function useEditHistory(
	state: EditSnapshot,
	set: {
		nodes: Dispatch<SetStateAction<SfNode[]>>;
		edges: Dispatch<SetStateAction<SfEdge[]>>;
		meta: Dispatch<SetStateAction<DocMeta>>;
		drafts(drafts: ReadonlyMap<string, FieldDraft>): void;
	},
	apply: { nodes(changes: NodeChange<SfNode>[]): void; edges(changes: EdgeChange<SfEdge>[]): void },
) {
	const [stack] = useState(() => new UndoStack<EditSnapshot>());
	const [, setVersion] = useState(0);
	const latest = useRef(state);
	latest.current = state;
	const handlers = useRef({ set, apply });
	handlers.current = { set, apply };
	const inTask = useRef(false);
	const dragging = useRef(false);

	const checkpoint = useCallback(
		(key?: string) => {
			if (inTask.current) return;
			inTask.current = true;
			queueMicrotask(() => {
				inTask.current = false;
			});
			stack.record(latest.current, key === undefined ? {} : { key });
			setVersion((v) => v + 1);
		},
		[stack],
	);

	const restore = useCallback((snapshot: EditSnapshot | undefined) => {
		if (!snapshot) return false;
		const { set } = handlers.current;
		set.nodes(snapshot.nodes);
		set.edges(snapshot.edges);
		set.meta(snapshot.meta);
		set.drafts(snapshot.drafts);
		setVersion((v) => v + 1);
		return true;
	}, []);
	const undo = useCallback(() => restore(stack.undo(latest.current)), [restore, stack]);
	const redo = useCallback(() => restore(stack.redo(latest.current)), [restore, stack]);

	const onNodesChange = useCallback(
		(changes: NodeChange<SfNode>[]) => {
			for (const c of changes) {
				if (c.type === "position") {
					if (c.dragging && !dragging.current) {
						dragging.current = true;
						checkpoint();
					} else if (c.dragging === false) {
						dragging.current = false;
					}
				} else if (c.type === "remove" || c.type === "add" || c.type === "replace") {
					checkpoint();
				}
			}
			handlers.current.apply.nodes(changes);
		},
		[checkpoint],
	);
	const onEdgesChange = useCallback(
		(changes: EdgeChange<SfEdge>[]) => {
			if (changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace")) {
				checkpoint();
			}
			handlers.current.apply.edges(changes);
		},
		[checkpoint],
	);

	return {
		checkpoint,
		undo,
		redo,
		canUndo: stack.canUndo,
		canRedo: stack.canRedo,
		onNodesChange,
		onEdgesChange,
	};
}
