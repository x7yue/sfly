import { describe, expect, it } from "vitest";
import { type KeyInput, keyLabels, type ShortcutDef, ShortcutMatcher } from "./shortcuts";

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

describe("快捷键显示", () => {
	it("拆成逐个按键的标签", () => {
		expect(keyLabels("Ctrl+K")).toEqual(["Ctrl", "K"]);
		expect(keyLabels("G D")).toEqual(["G", "D"]);
		expect(keyLabels("Alt+Shift+F")).toEqual(["Alt", "Shift", "F"]);
		expect(keyLabels("Esc")).toEqual(["Esc"]);
		expect(keyLabels("?")).toEqual(["?"]);
	});
});
