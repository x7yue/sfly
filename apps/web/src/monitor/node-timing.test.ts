import { describe, expect, it } from "vitest";
import { timingNote, timingTitle } from "./node-timing";

describe("节点用时的写法", () => {
	it("一次尝试有排队：写排队和执行", () => {
		const t = { total: 6000, queued: 2000, execution: 4000, attempts: 1 };
		expect(timingNote(t)).toBe("排队 2.0s · 执行 4.0s");
		expect(timingTitle(t)).toBe(
			"总耗时 6.0s（排队 2.0s · 执行 4.0s）：各次尝试从排队到结束的合计，含排队和等待，不含尝试之间的间隔",
		);
	});

	it("一次尝试没有排队：构成就是总耗时，不写", () => {
		const t = { total: 4000, queued: 0, execution: 4000, attempts: 1 };
		expect(timingNote(t)).toBeNull();
		expect(timingTitle(t)).toBe(
			"总耗时 4.0s：各次尝试从排队到结束的合计，含排队和等待，不含尝试之间的间隔",
		);
	});

	it("多次尝试：写共几次、排队合计、最近一次执行", () => {
		expect(timingNote({ total: 8500, queued: 500, execution: 5000, attempts: 2 })).toBe(
			"共 2 次尝试 · 排队合计 500ms · 最近一次执行 5.0s",
		);
		// 没有排队也要写明共几次和最近一次执行（总耗时里含了前面的尝试）
		expect(timingNote({ total: 8000, queued: 0, execution: 5000, attempts: 2 })).toBe(
			"共 2 次尝试 · 最近一次执行 5.0s",
		);
	});

	it("还在排队（没有执行）：只写排队", () => {
		expect(timingNote({ total: 2500, queued: 2500, execution: null, attempts: 1 })).toBe(
			"排队 2.5s",
		);
	});

	it("还没开始：没有用时", () => {
		const t = { total: null, queued: 0, execution: null, attempts: 0 };
		expect(timingNote(t)).toBeNull();
		expect(timingTitle(t)).toBeUndefined();
	});
});
