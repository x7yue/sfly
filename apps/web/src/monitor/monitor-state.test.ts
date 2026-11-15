import { describe, expect, it } from "vitest";
import { createMonitorStore } from "./monitor-state";

describe("定位日志（locateLog）", () => {
	const node = { chainInstanceId: "main", nodeId: "probe" };
	const at = Date.parse("2026-01-01T00:00:06.250Z");

	it("选中节点，切到日志页签并展开面板，记下要定位的时刻", () => {
		const store = createMonitorStore({ panelTab: "attempts", panelOpen: false });
		store.locateLog(node, at);
		expect(store.get()).toMatchObject({
			selected: node,
			panelTab: "logs",
			panelOpen: true,
			logMoment: { node, at },
		});
	});

	it("同一个时刻再请求一次，请求号也变：读者可能已经滚到别处，要重新定位", () => {
		const store = createMonitorStore();
		store.locateLog(node, at);
		const first = store.get().logMoment?.request;
		store.locateLog(node, at);
		expect(store.get().logMoment?.request).not.toBe(first);
	});

	it("之后选中别的节点、切换页签，不会清掉请求：它只对请求时的节点有效", () => {
		const store = createMonitorStore();
		store.locateLog(node, at);
		store.select({ chainInstanceId: "main", nodeId: "fetch" });
		store.showPanel("attempts");
		expect(store.get().logMoment?.node).toEqual(node);
	});
});
