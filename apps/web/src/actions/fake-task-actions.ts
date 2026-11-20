import type {
	ActionDetailView,
	ActionPage,
	ActionRecordDetail,
	CountOnlyPeriod,
} from "@sfly/schema";
import { FakeLive, FakePages } from "#/lib/fake-ports";
import type { TaskActionPorts } from "./task-action-reader";

/**
 * 内存里假的动作明细，给 task-action-reader 的测试当适配器。历史明细按开始时间从新到旧给定（`details`，测试自己排好），
 * 分页按它回答：最新一页是最前面的 `pageSize` 条，游标是下一页第一条的下标，读到最后一条之后游标为 null。
 * 每一页带着当时的修订号 `rev`。实时推送用 `emit`。要构造控制面不会给出的页（带只计数的段、修订号不同）时，
 * 用 `pages.replyNext(page)`。
 */

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
export const at = (ms: number) => new Date(T0 + ms).toISOString();

/** 第 id 个动作，在第 start 毫秒开始；不给 result 时还在做。 */
export function action(
	id: number,
	start: number,
	result: ActionRecordDetail["result"] = "success",
	name = "下单",
): ActionRecordDetail {
	return {
		kind: "action",
		id,
		parent: null,
		depth: 0,
		name,
		fields: {},
		started_at: at(start),
		agent_started_at: at(start),
		result,
		ended_at: result === null ? null : at(start + 5),
		agent_ended_at: result === null ? null : at(start + 5),
		duration_ms: result === null ? null : 5,
		reason: result === "failed" ? "拒单" : null,
	};
}

export const mark = (id: number, start: number, name = "首笔成交"): ActionDetailView => ({
	kind: "mark",
	id,
	parent: null,
	depth: 0,
	name,
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

export const period = (
	name: string,
	from: number,
	reason: CountOnlyPeriod["reason"] = "control_plane",
): CountOnlyPeriod => ({
	name,
	reason,
	from: at(from),
	agent_from: at(from),
	to: null,
	count: 10,
});

/** 控制面返回的一页。 */
export function actionPage(
	actions: ActionDetailView[],
	before: string | null,
	countOnly: CountOnlyPeriod[] = [],
	rev = 7,
): ActionPage {
	return { task_id: "t", actions, before, count_only: countOnly, rev, expired: false };
}

export interface FakeTaskActionsOptions {
	/** 每页的明细数（`limit`）。 */
	pageSize: number;
	/** 最新一页的修订号，默认 7。 */
	rev?: number;
}

export type ActionPosition = Parameters<TaskActionPorts["readPage"]>[0];

export class FakeTaskActions implements TaskActionPorts {
	/** 为 true 时，最新一页读到的是「运行已超过保留期」的空页。 */
	expired = false;
	readonly pages = new FakePages<ActionPosition, ActionPage>((position) => this.pageAt(position));
	readonly live = new FakeLive<number, (actions: readonly ActionDetailView[]) => void>();

	constructor(
		readonly details: ActionDetailView[],
		private readonly options: FakeTaskActionsOptions,
	) {}

	readPage = this.pages.read;
	subscribeLive = this.live.connect;

	/** 往还连着的实时推送推一批明细。 */
	emit(actions: ActionDetailView[]) {
		this.live.push((onActions) => onActions(actions));
	}

	private pageAt({ before }: ActionPosition): ActionPage {
		const start = before === undefined ? 0 : Number(before);
		const end = start + this.options.pageSize;
		const latest = before === undefined;
		const expired = latest && this.expired;
		return {
			...actionPage(
				expired ? [] : this.details.slice(start, end),
				end < this.details.length ? String(end) : null,
				[],
				this.options.rev ?? 7,
			),
			expired,
		};
	}
}
