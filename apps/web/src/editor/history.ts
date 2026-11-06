/**
 * 撤销 / 重做的命令栈（纯逻辑，单测见 history.test.ts）。每一步记录修改前的整个编辑状态（快照），
 * 撤销时换回快照、把当前状态放进重做栈。
 *
 * 连续的同类修改合并为一步：带同一个 `key`（例如同一个节点的参数输入）且与上一步间隔不超过
 * MERGE_WINDOW_MS 时，只保留第一次修改前的快照。撤销、重做之后不再与之前的修改合并。
 */

export const MERGE_WINDOW_MS = 1000;
const DEFAULT_LIMIT = 200;

export class UndoStack<T> {
	#undo: T[] = [];
	#redo: T[] = [];
	#limit: number;
	#last: { key: string; at: number } | null = null;

	constructor({ limit = DEFAULT_LIMIT }: { limit?: number } = {}) {
		this.#limit = limit;
	}

	get canUndo(): boolean {
		return this.#undo.length > 0;
	}

	get canRedo(): boolean {
		return this.#redo.length > 0;
	}

	/** 记录一次修改：before 是修改前的状态。 */
	record(before: T, { key, now = Date.now() }: { key?: string; now?: number } = {}): void {
		const last = this.#last;
		this.#last = key === undefined ? null : { key, at: now };
		this.#redo = [];
		if (last && key !== undefined && last.key === key && now - last.at <= MERGE_WINDOW_MS) {
			return;
		}
		this.#undo.push(before);
		if (this.#undo.length > this.#limit) this.#undo.shift();
	}

	/** 撤销：返回要换回的状态；没有可撤销的修改时返回 undefined。 */
	undo(current: T): T | undefined {
		const previous = this.#undo.pop();
		if (previous === undefined) return undefined;
		this.#redo.push(current);
		this.#last = null;
		return previous;
	}

	/** 重做：返回要换回的状态；没有可重做的修改时返回 undefined。 */
	redo(current: T): T | undefined {
		const next = this.#redo.pop();
		if (next === undefined) return undefined;
		this.#undo.push(current);
		this.#last = null;
		return next;
	}
}
