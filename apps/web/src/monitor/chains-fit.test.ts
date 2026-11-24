import { describe, expect, it } from "vitest";
import { type ChainsMeasure, chainsFitNext } from "./chains-fit";

const measure = (over: Partial<ChainsMeasure>): ChainsMeasure => ({
	clipped: false,
	short: 0,
	spare: 0,
	natural: 200,
	gap: 10,
	...over,
});

describe("chainsFitNext：顶栏写着失败摘要时，各链状态放不放得下（摘要放得下全文才一起显示）", () => {
	it("显示着、各链状态没被裁、摘要放得下全文：继续显示", () => {
		expect(chainsFitNext(true, measure({ clipped: false, short: 0 }))).toBe(true);
	});

	it("显示着、被别的内容挤得裁掉了：收起", () => {
		expect(chainsFitNext(true, measure({ clipped: true }))).toBe(false);
	});

	it("显示着、摘要被截成了省略号（哪怕各链状态没被裁）：收起", () => {
		expect(chainsFitNext(true, measure({ clipped: false, short: 40 }))).toBe(false);
		expect(chainsFitNext(true, measure({ clipped: false, short: 0.5 }))).toBe(false);
	});

	it("收起着、摘要放下全文之后剩的宽度不够各链状态排成一行（宽度加一个间距）：继续收起", () => {
		expect(chainsFitNext(false, measure({ spare: 209 }))).toBe(false);
		expect(chainsFitNext(false, measure({ spare: 0 }))).toBe(false);
	});

	it("收起着、剩的宽度刚好够（宽度加间距）：显示；再宽更是", () => {
		expect(chainsFitNext(false, measure({ spare: 210 }))).toBe(true);
		expect(chainsFitNext(false, measure({ spare: 600 }))).toBe(true);
	});

	it("收起着、摘要单独也放不下全文：不管空白占位多宽都收起（空白占位和摘要被截掉的一截互相抵）", () => {
		expect(chainsFitNext(false, measure({ spare: 0, short: 30 }))).toBe(false);
		expect(chainsFitNext(false, measure({ spare: 220, short: 30 }))).toBe(false);
		// 空白占位比各链状态要的多出摘要少的那一截：摘要全文加各链状态正好放得下。
		expect(chainsFitNext(false, measure({ spare: 240, short: 30 }))).toBe(true);
	});

	it("显示和收起之间不来回跳：刚好放得下的宽度下，收起着会被判成放得下，显示着不会被判成裁掉或截断（两个方向同一个界限）", () => {
		// 收起着：摘要全文放得下，剩的宽度刚好是各链状态加一个间距；各链状态一显示，摘要正好还是全文，各链状态不被裁。
		let fits = false;
		fits = chainsFitNext(fits, measure({ spare: 210, short: 0 }));
		expect(fits).toBe(true);
		fits = chainsFitNext(fits, measure({ clipped: false, short: 0, spare: 0 }));
		expect(fits).toBe(true);
		// 再窄 1px：显示着的摘要被截掉 1px，判成放不下、收起；收起后剩的宽度比各链状态要的少 1px，仍是收起。
		fits = chainsFitNext(fits, measure({ clipped: false, short: 1, spare: 0 }));
		expect(fits).toBe(false);
		fits = chainsFitNext(fits, measure({ spare: 209, short: 0 }));
		expect(fits).toBe(false);
	});
});
