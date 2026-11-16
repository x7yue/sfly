import { describe, expect, it } from "vitest";
import {
	initialView,
	MONITOR_VIEW_KEY,
	nextView,
	readRememberedView,
	rememberView,
} from "./monitor-view";

describe("运行监控打开时的视图", () => {
	it("默认是概览", () => {
		expect(initialView({ address: {}, run: { status: "running" }, remembered: null })).toBe(
			"overview",
		);
		expect(initialView({ address: {}, run: { status: "success" }, remembered: null })).toBe(
			"overview",
		);
	});

	it("没有地址参数时用浏览器记住的上次视图", () => {
		expect(initialView({ address: {}, run: { status: "running" }, remembered: "detail" })).toBe(
			"detail",
		);
		expect(initialView({ address: {}, run: { status: "success" }, remembered: "overview" })).toBe(
			"overview",
		);
	});

	it("地址里写明的视图优先，包括失败的运行", () => {
		expect(
			initialView({ address: { view: "detail" }, run: { status: "running" }, remembered: null }),
		).toBe("detail");
		expect(
			initialView({
				address: { view: "overview" },
				run: { status: "failed" },
				remembered: "detail",
			}),
		).toBe("overview");
	});

	it("失败和取消的运行总是先打开详情，不看记住的视图", () => {
		for (const status of ["failed", "cancelled"] as const) {
			expect(initialView({ address: {}, run: { status }, remembered: "overview" })).toBe("detail");
		}
	});

	it("没写视图时，地址里给了节点、页签或时刻就打开详情", () => {
		for (const address of [
			{ node: "fetch" },
			{ tab: "logs" as const },
			{ at: "2026-01-01T00:00:00.000Z" },
		]) {
			expect(initialView({ address, run: { status: "running" }, remembered: "overview" })).toBe(
				"detail",
			);
		}
	});
});

describe("标签页的方向键", () => {
	it("左右键在两个标签之间循环，Home 到第一个，End 到最后一个", () => {
		expect(nextView("overview", "ArrowRight")).toBe("detail");
		expect(nextView("detail", "ArrowRight")).toBe("overview");
		expect(nextView("overview", "ArrowLeft")).toBe("detail");
		expect(nextView("detail", "ArrowLeft")).toBe("overview");
		expect(nextView("detail", "Home")).toBe("overview");
		expect(nextView("overview", "End")).toBe("detail");
	});

	it("其他键不处理", () => {
		expect(nextView("overview", "Enter")).toBeNull();
		expect(nextView("overview", "ArrowDown")).toBeNull();
	});
});

describe("浏览器记住的视图", () => {
	const memory = () => {
		const data = new Map<string, string>();
		return {
			data,
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value),
		};
	};

	it("记下来的值能读回来", () => {
		const storage = memory();
		expect(readRememberedView(storage)).toBeNull();
		rememberView("detail", storage);
		expect(readRememberedView(storage)).toBe("detail");
		rememberView("overview", storage);
		expect(readRememberedView(storage)).toBe("overview");
	});

	it("存的值不合法时当作没记过", () => {
		const storage = memory();
		storage.data.set(MONITOR_VIEW_KEY, "metrics");
		expect(readRememberedView(storage)).toBeNull();
	});
});
