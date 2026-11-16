import type { RunView } from "@sfly/schema";
import type { MonitorSearch } from "./run-link";

/**
 * 运行监控页的两个视图：概览（默认）和详情（原来的页面）。当前视图写在地址的 `view` 参数里（run-link.ts），
 * 浏览器在 localStorage 里记住上次停在哪个视图。
 */
export const MONITOR_VIEWS = ["overview", "detail"] as const;
export type MonitorView = (typeof MONITOR_VIEWS)[number];

export const MONITOR_VIEW_KEY = "sfly.monitor.view";

const isView = (value: unknown): value is MonitorView =>
	(MONITOR_VIEWS as readonly unknown[]).includes(value);

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

/** 浏览器记住的上次视图；没记过或存的值不合法为 null。 */
export function readRememberedView(storage: ViewStorage = window.localStorage): MonitorView | null {
	try {
		const saved = storage.getItem(MONITOR_VIEW_KEY);
		return isView(saved) ? saved : null;
	} catch {
		return null;
	}
}

/** 记下用户切到的视图；自动打开的详情（失败的运行）不算用户的选择，不记。 */
export function rememberView(view: MonitorView, storage: ViewStorage = window.localStorage) {
	try {
		storage.setItem(MONITOR_VIEW_KEY, view);
	} catch {
		// 存不下（隐私模式、配额）就算了：下次打开回到默认视图。
	}
}

/**
 * 打开运行监控时的视图，按优先顺序：
 * 1. 地址里写明的 `view`（写了 `view=overview` 时，`node` 用来在概览里标出属于这个节点的关注项，`tab`、`at` 只在详情里有效）；
 * 2. 没写 `view`，地址里给了 `node`、`tab` 或 `at`：选中节点、切页签、定位到某一刻只有详情里做得到，所以打开详情；
 * 3. 失败和取消的运行总是先打开详情（有失败的节点时详情会选中第一个），不看记住的视图；
 * 4. 浏览器记住的上次视图；
 * 5. 概览。
 */
export function initialView({
	address,
	run,
	remembered,
}: {
	address: MonitorSearch;
	run: Pick<RunView, "status">;
	remembered: MonitorView | null;
}): MonitorView {
	if (address.view) return address.view;
	if (address.node !== undefined || address.tab !== undefined || address.at !== undefined) {
		return "detail";
	}
	if (run.status === "failed" || run.status === "cancelled") return "detail";
	return remembered ?? "overview";
}

/** 标签页上按方向键、Home、End 要切到的视图；不是这几个键为 null。 */
export function nextView(current: MonitorView, key: string): MonitorView | null {
	const at = MONITOR_VIEWS.indexOf(current);
	const last = MONITOR_VIEWS.length - 1;
	const to =
		key === "ArrowRight"
			? (at + 1) % MONITOR_VIEWS.length
			: key === "ArrowLeft"
				? (at + last) % MONITOR_VIEWS.length
				: key === "Home"
					? 0
					: key === "End"
						? last
						: null;
	return to === null ? null : (MONITOR_VIEWS[to] as MonitorView);
}
