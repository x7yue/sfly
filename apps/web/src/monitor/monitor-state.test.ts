import { describe, expect, it } from "vitest";
import { createMonitorStore } from "./monitor-state";

describe("共享状态里范围的部分", () => {
	const node = { chainInstanceId: "main", nodeId: "probe" };

	it("报告范围里发生的事，状态随之变化并通知订阅者；什么都没变时不通知", () => {
		const store = createMonitorStore();
		let notified = 0;
		store.subscribe(() => notified++);
		store.report({ type: "select", node });
		expect(store.get().scope.selected).toEqual(node);
		expect(notified).toBe(1);
		store.report({ type: "select", node: { ...node } });
		expect(notified).toBe(1);
	});

	it("时间轴的悬停、缩放、标记与范围互不影响", () => {
		const store = createMonitorStore();
		store.report({ type: "select", node });
		const scope = store.get().scope;
		store.hover(1);
		store.zoom({ start: 1, end: 2 });
		store.mark(3);
		expect(store.get()).toMatchObject({ hoverAt: 1, zoom: { start: 1, end: 2 }, marker: 3, scope });
		store.followLive();
		expect(store.get().zoom).toBeNull();
	});
});
