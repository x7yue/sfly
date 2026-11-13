import { describe, expect, it } from "vitest";
import { clampPanelWidth } from "./panel-width";

describe("clampPanelWidth", () => {
	it("范围内的宽度原样保留（取整）", () => {
		expect(clampPanelWidth(520.4, 1440, 372)).toBe(520);
	});
	it("不小于下限", () => {
		expect(clampPanelWidth(200, 1440, 372)).toBe(372);
	});
	it("不大于视口宽度的 60%", () => {
		expect(clampPanelWidth(2000, 1440, 372)).toBe(864);
	});
	it("没有保存过宽度时用下限", () => {
		expect(clampPanelWidth(null, 1440, 372)).toBe(372);
		expect(clampPanelWidth(null, 1440, 460)).toBe(460);
	});
	it("视口窄到 60% 不足下限时仍用下限", () => {
		expect(clampPanelWidth(500, 500, 372)).toBe(372);
	});
	it("给左边的内容留出 reserve：上限取视口 60% 与「视口减 reserve」里小的那个", () => {
		expect(clampPanelWidth(2000, 1280, 372, 742)).toBe(538);
		expect(clampPanelWidth(2000, 1440, 372, 742)).toBe(698);
		expect(clampPanelWidth(2000, 1920, 372, 742)).toBe(1152);
	});
	it("留出 reserve 之后放不下下限时仍用下限", () => {
		expect(clampPanelWidth(2000, 1024, 372, 742)).toBe(372);
	});
});
