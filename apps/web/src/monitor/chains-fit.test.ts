import { describe, expect, it } from "vitest";
import { type ChainsMeasure, chainsFitNext } from "./chains-fit";

const measure = (over: Partial<ChainsMeasure>): ChainsMeasure => ({
	clipped: false,
	extra: 0,
	natural: 200,
	gap: 10,
	...over,
});

describe("chainsFitNext：顶栏写着失败摘要时，各链状态放不放得下", () => {
	it("显示着、没被裁：继续显示", () => {
		expect(chainsFitNext(true, measure({ clipped: false }))).toBe(true);
	});

	it("显示着、被别的内容挤得裁掉了：收起", () => {
		expect(chainsFitNext(true, measure({ clipped: true }))).toBe(false);
	});

	it("收起着、摘要让出来的宽度不够它排成一行（要它的宽度加一个间距）：继续收起", () => {
		expect(chainsFitNext(false, measure({ extra: 209 }))).toBe(false);
		expect(chainsFitNext(false, measure({ extra: 0 }))).toBe(false);
	});

	it("收起着、让出来的宽度刚好够（宽度加间距）：显示；再宽更是", () => {
		expect(chainsFitNext(false, measure({ extra: 210 }))).toBe(true);
		expect(chainsFitNext(false, measure({ extra: 600 }))).toBe(true);
	});

	it("显示和收起之间不来回跳：刚好够的宽度下，显示着不会被判成裁掉、收起着会被判成放得下（两个方向同一个界限）", () => {
		// 显示着的时候刚好放得下就没有被裁；这时把各链状态收起，摘要让出来的就是它的宽度加一个间距。
		let fits = false;
		fits = chainsFitNext(fits, measure({ extra: 210 }));
		expect(fits).toBe(true);
		fits = chainsFitNext(fits, measure({ clipped: false }));
		expect(fits).toBe(true);
	});
});
