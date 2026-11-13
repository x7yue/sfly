import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { ToolButton } from "#/components/canvas/CanvasDock";
import type { KeyHint, Keys } from "#/components/page";
import type { Kbd } from "#/components/ui/kbd";
import {
	type KeyInput,
	keyChords,
	keyLabels,
	SHORTCUTS,
	type ShortcutDef,
	ShortcutMatcher,
	shortcutKeys,
	shortcutText,
} from "./shortcuts";

const defs: ShortcutDef[] = [
	{ id: "palette", group: "全局", label: "命令面板", keys: "Ctrl+K", inInputs: true },
	{ id: "help", group: "全局", label: "快捷键面板", keys: "?" },
	{ id: "go-dashboard", group: "全局", label: "控制台", keys: "G D" },
	{ id: "go-scenarios", group: "全局", label: "场景编排", keys: "G S" },
	{ id: "tidy", group: "编排画布", label: "整理布局", keys: "Alt+Shift+F" },
];

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
	key: k,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	editable: false,
	...extra,
});

describe("快捷键匹配", () => {
	it("带修饰键的组合：Ctrl 与 ⌘ 都算 Ctrl，缺修饰键不触发", () => {
		const m = new ShortcutMatcher(defs);
		expect(m.handle(key("k", { ctrlKey: true }), 0)).toBe("palette");
		expect(m.handle(key("K", { metaKey: true }), 10)).toBe("palette");
		expect(m.handle(key("k"), 20)).toBeNull();
		expect(m.handle(key("F", { altKey: true, shiftKey: true }), 30)).toBe("tidy");
		expect(m.handle(key("F", { altKey: true }), 40)).toBeNull();
	});

	it("符号键不要求写出 Shift：按 Shift+/ 得到的 ? 触发快捷键面板", () => {
		const m = new ShortcutMatcher(defs);
		expect(m.handle(key("?", { shiftKey: true }), 0)).toBe("help");
	});

	it("按键序列在 1 秒内依次按下才触发，超时后重新开始", () => {
		const m = new ShortcutMatcher(defs);
		expect(m.handle(key("g"), 0)).toBeNull();
		expect(m.handle(key("d"), 400)).toBe("go-dashboard");

		expect(m.handle(key("g"), 1000)).toBeNull();
		expect(m.handle(key("s"), 2500)).toBeNull();

		// 序列中按了别的键：从这个键重新开始匹配。
		expect(m.handle(key("g"), 3000)).toBeNull();
		expect(m.handle(key("x"), 3100)).toBeNull();
		expect(m.handle(key("s"), 3200)).toBeNull();
		expect(m.handle(key("g"), 3300)).toBeNull();
		expect(m.handle(key("s"), 3400)).toBe("go-scenarios");
	});

	it("焦点在输入框里时只触发允许在输入框中使用的快捷键", () => {
		const m = new ShortcutMatcher(defs);
		expect(m.handle(key("g", { editable: true }), 0)).toBeNull();
		expect(m.handle(key("d", { editable: true }), 100)).toBeNull();
		expect(m.handle(key("?", { editable: true, shiftKey: true }), 200)).toBeNull();
		expect(m.handle(key("k", { editable: true, ctrlKey: true }), 300)).toBe("palette");
	});

	it("只按下修饰键不会打断正在输入的序列", () => {
		const m = new ShortcutMatcher(defs);
		expect(m.handle(key("g"), 0)).toBeNull();
		expect(m.handle(key("Shift", { shiftKey: true }), 100)).toBeNull();
		expect(m.handle(key("d"), 200)).toBe("go-dashboard");
	});
});

describe("只匹配已绑定的快捷键", () => {
	const pages: ShortcutDef[] = [
		{ id: "canvas-mode-run", group: "编排画布", label: "运行状态模式", keys: "R" },
		{ id: "monitor-rerun", group: "运行监控", label: "再次运行", keys: "R" },
		{ id: "go-dashboard", group: "全局", label: "控制台", keys: "G D" },
	];
	const bound =
		(...ids: string[]) =>
		(id: string) =>
			ids.includes(id);

	it("不同页面分组登记同一个键时，按键属于当前已绑定的那一个", () => {
		const m = new ShortcutMatcher(pages);
		expect(m.handle(key("r"), 0, bound("monitor-rerun"))).toBe("monitor-rerun");
		expect(m.handle(key("r"), 10, bound("canvas-mode-run"))).toBe("canvas-mode-run");
	});

	it("没有绑定的快捷键不匹配，也不会让序列停在半路", () => {
		const m = new ShortcutMatcher(pages);
		expect(m.handle(key("r"), 0, bound())).toBeNull();
		expect(m.handle(key("g"), 100, bound())).toBeNull();
		expect(m.handle(key("d"), 200, bound())).toBeNull();
		expect(m.handle(key("g"), 300, bound("go-dashboard"))).toBeNull();
		expect(m.handle(key("d"), 400, bound("go-dashboard"))).toBe("go-dashboard");
	});
});

describe("快捷键注册表", () => {
	const live = SHORTCUTS.filter((s) => !("displayOnly" in s));
	const sameKeys = (a: ShortcutDef, b: ShortcutDef) =>
		a.keys.toLowerCase() === b.keys.toLowerCase();
	const clashes = (items: readonly ShortcutDef[]) =>
		items.flatMap((a, i) =>
			items
				.slice(i + 1)
				.filter((b) => sameKeys(a, b))
				.map((b) => `${a.id} 与 ${b.id}（${a.keys}）`),
		);

	it("「全局」的键不与任何分组重复：全局快捷键在每个页面都生效", () => {
		const global = live.filter((s) => s.group === "全局");
		const others = live.filter((s) => s.group !== "全局");
		expect(global.flatMap((g) => others.filter((o) => sameKeys(g, o)).map((o) => o.id))).toEqual(
			[],
		);
	});

	it("同一分组内的键不重复（不同页面分组之间可以重复：它们是互斥的路由）", () => {
		for (const group of new Set(live.map((s) => s.group))) {
			expect(clashes(live.filter((s) => s.group === group))).toEqual([]);
		}
	});
});

describe("快捷键显示", () => {
	it("拆成逐个按键的标签", () => {
		expect(keyLabels("Ctrl+K")).toEqual(["Ctrl", "K"]);
		expect(keyLabels("G D")).toEqual(["G", "D"]);
		expect(keyLabels("Alt+Shift+F")).toEqual(["Alt", "Shift", "F"]);
		expect(keyLabels("Esc")).toEqual(["Esc"]);
		expect(keyLabels("?")).toEqual(["?"]);
		// 依次按的分组，同时按的在一组（快捷键面板据此区分「G 然后 D」与「Ctrl K」）。
		expect(keyChords("G D")).toEqual([["G"], ["D"]]);
		expect(keyChords("Ctrl+Shift+Z")).toEqual([["Ctrl", "Shift", "Z"]]);
		expect(keyChords("←/→")).toEqual([["←/→"]]);
	});

	it("写在文字里的快捷键取自注册表", () => {
		expect(shortcutText("canvas-paste")).toBe("Ctrl V");
		expect(shortcutText("canvas-redo")).toBe("Ctrl Shift Z");
		expect(shortcutText("canvas-add")).toBe("/");
	});

	it("界面上的按键只能从注册表取（类型检查拦住写死的按键）", () => {
		// @ts-expect-error Kbd 的内容是 KeyLabel，不能写死
		const kbd: ComponentProps<typeof Kbd>["children"] = "Ctrl S";
		// @ts-expect-error 按钮提示的快捷键是注册表 id，不是按键文字
		const tool: ComponentProps<typeof ToolButton>["shortcut"] = "Ctrl Z";
		// @ts-expect-error 同上
		const keys: ComponentProps<typeof Keys>["shortcut"] = "?";
		// @ts-expect-error 操作说明只能用 OperationKey 里的键
		const hint: ComponentProps<typeof KeyHint>["keys"] = "Ctrl K";
		const fromRegistry: ComponentProps<typeof Kbd>["children"] = shortcutText("canvas-undo");
		expect([kbd, tool, keys, hint, fromRegistry]).toHaveLength(5);
		expect(shortcutKeys("go-agents")).toEqual([["G"], ["A"]]);
	});
});
