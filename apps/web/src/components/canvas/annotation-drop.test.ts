import { annotationBoxes, type LayoutDocument, NODE_SIZE } from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	annotationDrop,
	cardCenter,
	detachedAnnotations,
	dropHint,
	hasDropEffect,
} from "./annotation-drop";

// 拖动节点进出注释框：松手时卡片中心落在哪个框里（取最里面的）就加入它；按住 Alt 拖动是从原来的框里拖出。

const node = (id: string, x: number, y: number) => ({
	id,
	kind: "package" as const,
	position: { x, y },
});

/** a、b 在「准备」里，c、e 在「收尾」里，d 不在任何框里；「收尾」框里还套着只框 c 的「细节」。 */
const layout = (moved: Record<string, { x: number; y: number }> = {}): LayoutDocument => ({
	nodes: [
		node("a", 0, 0),
		node("b", 260, 0),
		node("c", 0, 400),
		node("e", 260, 400),
		node("d", 700, 700),
	].map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)),
	edges: [],
});
const annotations: Annotation[] = [
	{ id: "prep", title: "准备", nodes: ["a", "b"], subflows: [] },
	{ id: "tail", title: "收尾", nodes: ["c", "e"], subflows: [] },
	{ id: "detail", title: "细节", nodes: ["c"], subflows: [] },
];

function drop(
	dragged: string[],
	to: { x: number; y: number },
	detach = false,
	list: readonly Annotation[] = annotations,
) {
	const moved = Object.fromEntries(dragged.map((id) => [id, to]));
	return annotationDrop({
		annotations: list,
		layout: layout(moved),
		dragged,
		center: cardCenter(to),
		detach,
	});
}

describe("拖动节点进出注释框", () => {
	it("不在框里的节点拖进框：中心进了框就加入它", () => {
		const result = drop(["d"], { x: 100, y: 10 });
		expect(result.join).toEqual({ id: "prep", title: "准备", nodes: ["d"] });
		expect(result.leave).toEqual([]);
		expect(dropHint(result)).toBe("松手加入「准备」");
	});

	it("中心没进框（只压住框的边）不加入", () => {
		const prep = annotationBoxes({ ...layout(), annotations })[0]?.box;
		if (!prep) throw new Error("没有画出「准备」");
		const result = drop(["d"], { x: prep.x + prep.w - NODE_SIZE.width / 2 + 10, y: 0 });
		expect(hasDropEffect(result)).toBe(false);
		expect(dropHint(result)).toBeNull();
	});

	it("几个框叠着时加入最里面的那个", () => {
		expect(drop(["d"], { x: 10, y: 410 }).join?.id).toBe("detail");
	});

	it("在自己的框里挪动、拖到自己已经在的框里：什么都不改", () => {
		expect(hasDropEffect(drop(["a"], { x: 40, y: 20 }))).toBe(false);
		// 普通拖动只加入不离开：a 被拖到「收尾」里时加入它，仍留在「准备」里。
		const result = drop(["a"], { x: 10, y: 410 });
		expect(result.join).toEqual({ id: "detail", title: "细节", nodes: ["a"] });
		expect(result.leave).toEqual([]);
	});

	it("一起拖动的几个节点：只加入还不在这个框里的；带着自己的框走的成员不会让它们落进自己的框", () => {
		// c 的「收尾」「细节」跟着 c 走，但落点按不含 c 的框算：落在「准备」里。
		const result = drop(["c", "d"], { x: 100, y: 10 });
		expect(result.join).toEqual({ id: "prep", title: "准备", nodes: ["c", "d"] });
		const back = drop(["a", "d"], { x: 40, y: 20 });
		expect(back.join).toEqual({ id: "prep", title: "准备", nodes: ["d"] });
	});

	it("按住 Alt 拖出：框不再跟着走，松手时移出；拖进别的框时同时加入", () => {
		const out = drop(["a"], { x: 900, y: 900 }, true);
		expect(out.join).toBeNull();
		expect(out.leave).toEqual([{ id: "prep", title: "准备", emptied: false }]);
		expect(dropHint(out)).toBe("松手移出「准备」");

		const moved = drop(["a"], { x: 10, y: 410 }, true);
		expect(moved.leave).toEqual([{ id: "prep", title: "准备", emptied: false }]);
		expect(moved.join).toEqual({ id: "detail", title: "细节", nodes: ["a"] });
		expect(dropHint(moved)).toBe("松手移出「准备」，加入「细节」");
	});

	it("按住 Alt 拖回原来的框里（框现在只框着没被拖动的 b）：留在里面，不移出也不重复加入", () => {
		expect(hasDropEffect(drop(["a"], { x: 250, y: 10 }, true))).toBe(false);
		// 框不再跟着 a，a 的中心离开只框着 b 的框就是移出。
		expect(drop(["a"], { x: 40, y: 20 }, true).leave).toEqual([
			{ id: "prep", title: "准备", emptied: false },
		]);
	});

	it("按住 Alt 拖出最后一个成员：提示里写明注释框会一起删除", () => {
		const result = drop(["c"], { x: 900, y: 900 }, true);
		expect(result.leave).toEqual([
			{ id: "tail", title: "收尾", emptied: false },
			{ id: "detail", title: "细节", emptied: true },
		]);
		expect(dropHint(result)).toBe("松手移出「收尾」「细节」；「细节」没有别的成员，会一起删除");
	});

	it("在嵌着的小框里挪动：小框还有别的成员时按画出来的样子算，不会落进外面的大框", () => {
		// 外框「整段」框着 a、b、c、e，嵌在里面的小框「细节 2」框着 a、b；拖动 a 时 b 不动。
		const nested: Annotation[] = [
			{ id: "outer", title: "整段", nodes: ["a", "b", "c", "e"], subflows: [] },
			{ id: "inner", title: "细节 2", nodes: ["a", "b"], subflows: [] },
		];
		expect(hasDropEffect(drop(["a"], { x: 60, y: 30 }, false, nested))).toBe(false);
	});

	it("按住 Alt 时画框用的注释框去掉拖动的节点；不涉及的注释框原样保留", () => {
		const shown = detachedAnnotations(annotations, ["a"]);
		expect(shown[0]).toEqual({ id: "prep", title: "准备", nodes: ["b"], subflows: [] });
		expect(shown[1]).toBe(annotations[1]);
	});

	it("没有一个节点在任何框里时不影响", () => {
		expect(hasDropEffect(drop(["d"], { x: 900, y: 900 }))).toBe(false);
		expect(hasDropEffect(drop(["d"], { x: 900, y: 900 }, true))).toBe(false);
	});
});
