import { CHAIN_WRAP_DROP } from "@sfly/orchestration";
import { describe, expect, it } from "vitest";
import { edgePath } from "./edge-path";

describe("链连线的路径", () => {
	it("同一行：直线，「＋」在中点", () => {
		expect(edgePath("chain", [0, 56], [44, 56])).toEqual({ d: "M0 56 L44 56", center: [22, 56] });
	});

	it("换到下一行（两行主链相邻）：在上一行卡片底边往下 34 处往左折回，在目标左侧 40 处（注释框的框外）竖直落下", () => {
		const { d, center } = edgePath("chain", [1456, 30], [0, 192]);
		expect(CHAIN_WRAP_DROP).toBe(30 + 34);
		// 水平走到拐角，竖直落到目标所在的高度附近，再水平进入目标。
		expect(d).toContain("L-28 94");
		expect(d).toContain("L-40 180");
		expect(d.endsWith("L0 192")).toBe(true);
		expect(center).toEqual([728, 94]);
	});

	it("两行之间夹着子流程：贴着上一行折回，不从子流程中间穿过；「＋」在折回的那段上", () => {
		const { d, center } = edgePath("chain", [712, 270], [0, 1606]);
		expect(d).toContain(`L-28 ${270 + CHAIN_WRAP_DROP}`);
		expect(center).toEqual([356, 270 + CHAIN_WRAP_DROP]);
	});

	it("目标在上方的回绕：仍在两端之间的正中折回", () => {
		const { d } = edgePath("chain", [500, 400], [0, 100]);
		expect(d).toContain("L0 250");
	});
});
