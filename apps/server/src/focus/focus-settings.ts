import type { FocusEditView, FocusItemView } from "@sfly/schema";
import type { Actor } from "../actor.js";
import type { Db } from "../db/database.js";
import type { orchestrations, StoredFocusEdit } from "../db/schema.js";
import {
	checkFocusList,
	describeFocusChange,
	describeFocusUndo,
	type FocusItem,
	type FocusRejection,
	focusKey,
	sameFocusList,
} from "./focus-list.js";
import { focusItemViews } from "./focus-views.js";

type OrchestrationRow = typeof orchestrations.$inferSelect;

/** 关注项在场景表里的两列。 */
export type FocusColumns = Pick<OrchestrationRow, "focusItems" | "focusEdit">;

/**
 * 场景视图里的关注项：每项带它在最新版本里的状态，加上最后一次修改。
 * 在事务里调用时传 `tx`（`Tx` 可以当 `Db` 用）：事务已经占着一个连接，不能再去连接池里另取一个。
 */
export async function focusFields(
	db: Db,
	row: OrchestrationRow,
): Promise<{ focus_items: FocusItemView[]; focus_edit: FocusEditView | null }> {
	const { focusEdit } = row;
	return {
		focus_items: await focusItemViews(db, row, row.focusItems),
		focus_edit: focusEdit
			? { updated_by: focusEdit.by, updated_at: focusEdit.at, summary: focusEdit.summary }
			: null,
	};
}

/** 整份替换关注项的结果：被拒绝；和现在一样（不算修改）；或者要写入的两列。 */
export type FocusReplacement =
	| { kind: "rejected"; rejection: FocusRejection }
	| { kind: "unchanged" }
	| { kind: "replaced"; columns: FocusColumns };

/**
 * 用 `requested` 整份替换场景的关注项（调用方已对场景行加了排他锁，`row` 是锁住之后读到的）：
 * 列表自身要合格（不超过 8 项、没有重复）；新加入的项（现在的列表里没有的）要引用最新版本里存在的节点和图表，
 * 已经在列表里、后来失效的项可以原样保留。和现在一样的列表不算修改。
 * 把上一次修改之前的列表写回去记为撤销：它回到的是原来的状态，里面已经失效的项（上一次修改移除的）不当作新加入的检查。
 */
export async function replaceFocusItems(
	db: Db,
	row: OrchestrationRow,
	requested: readonly FocusItem[],
	actor: Actor,
	now: Date,
): Promise<FocusReplacement> {
	const invalid = checkFocusList(requested);
	if (invalid) return { kind: "rejected", rejection: invalid };
	if (sameFocusList(row.focusItems, requested)) return { kind: "unchanged" };

	const before = row.focusEdit?.before;
	const undo = before != null && sameFocusList(before, requested);
	if (!undo) {
		const existing = new Set(row.focusItems.map(focusKey));
		const added = requested.filter((item) => !existing.has(focusKey(item)));
		const unknown = (await focusItemViews(db, row, added)).filter((view) => view.status !== "ok");
		if (unknown.length > 0) return { kind: "rejected", rejection: unknownChart(unknown) };
	}
	return {
		kind: "replaced",
		columns: {
			focusItems: [...requested],
			focusEdit: {
				by: actor.nickname,
				at: now.toISOString(),
				summary: undo
					? describeFocusUndo(row.focusItems, requested)
					: describeFocusChange(row.focusItems, requested),
				before: undo ? null : row.focusItems,
			},
		},
	};
}

function unknownChart(unknown: readonly FocusItemView[]): FocusRejection {
	const [first] = unknown as [FocusItemView, ...FocusItemView[]];
	const reason =
		first.status === "node_missing"
			? `最新版本里没有节点 ${first.node_id}`
			: `节点 ${first.node_id} 的节点类型没有图表「${first.chart}」（图表按标题引用，要和节点包声明的标题一致）`;
	return {
		code: "focus_item_unknown_chart",
		message: `${reason}，不能把它设为关注项${unknown.length > 1 ? `（还有 ${unknown.length - 1} 项也不行）` : ""}`,
		details: unknown.map(({ node_id, chart }) => ({ node_id, chart })),
	};
}

/**
 * 复制场景时带给副本的关注项两列：列表原样复制（包括已经失效的项），最后修改记为复制的人和时间，
 * 写「复制自「源场景名」」；源场景没有关注项时副本也没有最后修改。
 */
export function copiedFocus(
	source: Pick<OrchestrationRow, "name" | "focusItems">,
	actor: Actor,
	now: Date,
): FocusColumns {
	const edit: StoredFocusEdit | null =
		source.focusItems.length === 0
			? null
			: {
					by: actor.nickname,
					at: now.toISOString(),
					summary: `复制自「${source.name}」`,
					before: null,
				};
	return { focusItems: source.focusItems, focusEdit: edit };
}
