import { describe, expect, it } from "vitest";
import { focusKey, focusName, sameFocusList } from "../src/index.js";

describe("关注项列表的规则", () => {
	const a = { node_id: "load", chart: "TPS" };
	const b = { node_id: "load", chart: "延迟", title: "下单延迟" };
	const b0 = { node_id: "load", chart: "TPS", title: "撮合 TPS" };
	const view = { node_id: "load", chart: "TPS", status: "ok", chart_type: "area" };

	it("身份只看来源节点和图表标题，名字不算", () => {
		expect(focusKey(a)).toBe(focusKey(b0));
		expect(focusKey(a)).not.toBe(focusKey({ ...a, node_id: "load2" }));
		expect(focusKey({ node_id: "a,b", chart: "c" })).not.toBe(
			focusKey({ node_id: "a", chart: "b,c" }),
		);
	});

	it("显示的名字：起了名用名字，没起名用图表标题", () => {
		expect(focusName(a)).toBe("TPS");
		expect(focusName(b)).toBe("下单延迟");
	});

	it("项、名字和顺序都一样才算一样列表；带状态的视图和请求里的项可以互相比", () => {
		expect(sameFocusList([a, b], [a, { ...b }])).toBe(true);
		expect(sameFocusList([a, b], [b, a])).toBe(false);
		expect(sameFocusList([a, b], [a, { ...b, title: "延迟" }])).toBe(false);
		expect(sameFocusList([a, b], [a])).toBe(false);
		expect(sameFocusList([view], [a])).toBe(true);
	});
});
