/**
 * 统一的快捷键注册表（纯逻辑，单测见 shortcuts.test.ts）。
 *
 * - 所有快捷键都登记在 SHORTCUTS 里：快捷键面板（?）从这里生成，页面用 `useShortcut(id, handler)`
 *   （#/components/shortcuts）绑定处理函数。新增快捷键先在这里加一行，再在页面里绑定；
 *   没有绑定处理函数的快捷键不要登记（面板内容必须与实际生效的一致）。
 * - keys 写法：`+` 连接同时按下的键（`Ctrl+K`、`Alt+Shift+F`），空格分隔依次按下的序列（`G D`，
 *   1 秒内按完）。Ctrl 同时匹配 ⌘。符号键（`?`）不需要写 Shift。
 * - 默认焦点在输入框里、或有弹窗打开时不触发；`inInputs` / `inDialogs` 放开限制。
 *   Esc 关闭浮层由弹窗组件自己处理，这里登记只为在面板里展示（`displayOnly`）。
 */

export type ShortcutGroup = "全局" | "编排画布" | "运行监控";

export interface ShortcutDef {
	id: string;
	group: ShortcutGroup;
	label: string;
	keys: string;
	/** 焦点在输入框、文本域或可编辑元素里时也触发。 */
	inInputs?: boolean;
	/** 有模态弹窗打开时也触发。 */
	inDialogs?: boolean;
	/** 只在面板里展示，由组件自身处理（例如 Esc 关闭浮层）。 */
	displayOnly?: boolean;
}

export const SHORTCUTS = [
	{
		id: "command-palette",
		group: "全局",
		label: "命令面板",
		keys: "Ctrl+K",
		inInputs: true,
		inDialogs: true,
	},
	{ id: "shortcuts-help", group: "全局", label: "快捷键面板", keys: "?" },
	{ id: "close-overlay", group: "全局", label: "关闭浮层", keys: "Esc", displayOnly: true },
	{ id: "go-dashboard", group: "全局", label: "控制台", keys: "G D" },
	{ id: "go-scenarios", group: "全局", label: "场景编排", keys: "G S" },
	{ id: "go-runs", group: "全局", label: "运行记录", keys: "G R" },
	{ id: "go-agents", group: "全局", label: "Agent 管理", keys: "G A" },
	{ id: "go-packages", group: "全局", label: "节点包管理", keys: "G P" },
	{ id: "toggle-sidebar", group: "全局", label: "折叠 / 展开侧边栏", keys: "Ctrl+B" },
	// 编排画布（全屏页）：方向键、Enter、Esc 由画布组件自己处理（components/canvas/FlowCanvas.tsx）。
	{
		id: "canvas-save",
		group: "编排画布",
		label: "保存",
		keys: "Ctrl+S",
		inInputs: true,
	},
	{ id: "canvas-mode-edit", group: "编排画布", label: "编辑模式", keys: "E" },
	{ id: "canvas-mode-run", group: "编排画布", label: "运行状态模式", keys: "R" },
	{ id: "canvas-undo", group: "编排画布", label: "撤销", keys: "Ctrl+Z" },
	{ id: "canvas-redo", group: "编排画布", label: "重做", keys: "Ctrl+Shift+Z" },
	{ id: "canvas-tidy", group: "编排画布", label: "整理布局", keys: "Alt+Shift+F" },
	// Tab 只在焦点在画布上时打开添加节点菜单（editor/ScenarioEditor.tsx），其他时候照常切换焦点。
	{ id: "canvas-add-tab", group: "编排画布", label: "添加节点", keys: "Tab", displayOnly: true },
	{ id: "canvas-add", group: "编排画布", label: "搜索节点类型", keys: "/" },
	{ id: "canvas-delete", group: "编排画布", label: "删除节点", keys: "Delete", displayOnly: true },
	{ id: "canvas-fit", group: "编排画布", label: "适配视图", keys: "0" },
	{ id: "canvas-pointer", group: "编排画布", label: "指针", keys: "V" },
	{ id: "canvas-hand", group: "编排画布", label: "抓手", keys: "H" },
	{ id: "canvas-minimap", group: "编排画布", label: "小地图", keys: "M" },
	{ id: "canvas-inspector", group: "编排画布", label: "检查器", keys: "I" },
	{ id: "canvas-chain", group: "编排画布", label: "沿链切换节点", keys: "← →", displayOnly: true },
	{ id: "canvas-subflow", group: "编排画布", label: "进出子流程", keys: "↓ ↑", displayOnly: true },
	{
		id: "canvas-to-inspector",
		group: "编排画布",
		label: "焦点移到检查器",
		keys: "Enter",
		displayOnly: true,
	},
	{ id: "canvas-deselect", group: "编排画布", label: "取消选中", keys: "Esc", displayOnly: true },
	{ id: "monitor-toggle-timeline", group: "运行监控", label: "时间线汇总 / 展开节点", keys: "T" },
] as const satisfies readonly ShortcutDef[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export const shortcutById = (id: ShortcutId): ShortcutDef => {
	const def = SHORTCUTS.find((s) => s.id === id);
	if (!def) throw new Error(`未登记的快捷键 ${id}`);
	return def;
};

/** 一次按键（KeyboardEvent 的子集）；editable 表示焦点在可输入的元素里。 */
export interface KeyInput {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	editable: boolean;
	/** 有模态弹窗打开。 */
	inDialog?: boolean;
}

interface Chord {
	key: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

const KEY_NAMES: Record<string, string> = { esc: "escape", space: " " };
const MODIFIER_KEYS = new Set(["control", "meta", "alt", "shift", "altgraph"]);

function parseChord(chord: string): Chord {
	const parts = chord.split("+").map((p) => p.trim().toLowerCase());
	const key = parts.at(-1) ?? "";
	return {
		key: KEY_NAMES[key] ?? key,
		ctrl: parts.includes("ctrl"),
		alt: parts.includes("alt"),
		shift: parts.includes("shift"),
	};
}

const parseKeys = (keys: string): Chord[] => keys.trim().split(/\s+/).map(parseChord);

/** 用于显示的逐个按键标签：`Ctrl+K` → `["Ctrl", "K"]`，`G D` → `["G", "D"]`。 */
export function keyLabels(keys: string): string[] {
	return keys
		.trim()
		.split(/\s+/)
		.flatMap((chord) => chord.split("+"))
		.map((k) => (k.length === 1 ? k.toUpperCase() : k));
}

function chordMatches(chord: Chord, input: KeyInput): boolean {
	const key = input.key.toLowerCase();
	if (key !== chord.key) return false;
	if ((input.ctrlKey || input.metaKey) !== chord.ctrl) return false;
	if (input.altKey !== chord.alt) return false;
	// 字母键区分 Shift；符号键（? ! …）本身就要按 Shift，不比较。
	const isLetter = /^[a-z]$/.test(chord.key);
	return !isLetter || input.shiftKey === chord.shift;
}

/** 按键序列的超时（毫秒）。 */
export const SEQUENCE_TIMEOUT = 1000;

/** 把按键流匹配成快捷键 id；序列的中间状态保存在实例里。 */
export class ShortcutMatcher<Id extends string = string> {
	#defs: { id: Id; chords: Chord[]; def: ShortcutDef }[];
	#pending: KeyInput[] = [];
	#lastAt = Number.NEGATIVE_INFINITY;

	constructor(defs: readonly (ShortcutDef & { id: Id })[]) {
		this.#defs = defs
			.filter((def) => !def.displayOnly)
			.map((def) => ({ id: def.id, chords: parseKeys(def.keys), def }));
	}

	/** 处理一次按键；匹配到快捷键时返回它的 id。now 为毫秒时间戳。 */
	handle(input: KeyInput, now: number): Id | null {
		if (MODIFIER_KEYS.has(input.key.toLowerCase())) return null;
		if (now - this.#lastAt > SEQUENCE_TIMEOUT) this.#pending = [];
		this.#lastAt = now;

		// 先尝试接在已有序列后面，不行再从这个键单独开始。
		for (const sequence of [[...this.#pending, input], [input]]) {
			const usable = this.#defs.filter(
				({ def, chords }) =>
					chords.length >= sequence.length &&
					(!input.editable || def.inInputs) &&
					(!input.inDialog || def.inDialogs) &&
					sequence.every((k, i) => chordMatches(chords[i] as Chord, k)),
			);
			const done = usable.find((d) => d.chords.length === sequence.length);
			if (done) {
				this.#pending = [];
				return done.id;
			}
			if (usable.length > 0) {
				this.#pending = sequence;
				return null;
			}
		}
		this.#pending = [];
		return null;
	}
}
