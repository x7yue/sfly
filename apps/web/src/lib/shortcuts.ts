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
 * - 不同页面分组（编排画布 / 运行监控 / 列表页）可以登记同一个键：它们属于互斥的路由，匹配时只看当前已绑定处理函数的
 *   （ShortcutMatcher.handle 的 isBound）。「全局」的键不能与任何分组重复，同一分组内也不能重复（单测检查）。
 */

export type ShortcutGroup = "全局" | "编排画布" | "运行监控" | "列表页";

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
	/** 绑定了处理函数时，同时作为命令出现在命令面板的「当前页面」分组里。 */
	palette?: true;
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
	{ id: "go-feishu-bots", group: "全局", label: "飞书机器人", keys: "G F" },
	{ id: "go-docs", group: "全局", label: "开发文档", keys: "G H" },
	{ id: "toggle-sidebar", group: "全局", label: "折叠 / 展开侧边栏", keys: "Ctrl+B" },
	{ id: "new-scenario", group: "全局", label: "新建场景", keys: "N" },
	// 编排画布（全屏页）：方向键、Enter、Esc 由画布组件自己处理（components/canvas/FlowCanvas.tsx）。
	{
		id: "canvas-save",
		group: "编排画布",
		label: "保存",
		keys: "Ctrl+S",
		inInputs: true,
		palette: true,
	},
	{ id: "canvas-run", group: "编排画布", label: "运行", keys: "Ctrl+Enter", palette: true },
	{ id: "canvas-mode-edit", group: "编排画布", label: "编辑模式", keys: "E" },
	{ id: "canvas-mode-run", group: "编排画布", label: "运行状态模式", keys: "R" },
	{ id: "canvas-undo", group: "编排画布", label: "撤销", keys: "Ctrl+Z" },
	{ id: "canvas-redo", group: "编排画布", label: "重做", keys: "Ctrl+Shift+Z" },
	{ id: "canvas-tidy", group: "编排画布", label: "整理布局", keys: "Alt+Shift+F" },
	// 添加节点（editor/ScenarioEditor.tsx）：/ 添加的节点不连线；焦点在节点卡片上按 Tab，新节点接在它后面
	// （用鼠标点过画布空白处后按 Tab 等同于 /，其他时候 Tab 照常切换焦点）。
	{ id: "canvas-add", group: "编排画布", label: "添加节点", keys: "/" },
	{
		id: "canvas-add-tab",
		group: "编排画布",
		label: "在节点后面添加",
		keys: "Tab",
		displayOnly: true,
	},
	// 选中的是节点时删除节点（editor/ScenarioEditor.tsx 的 deleteNode），是连线时断开连线（FlowCanvas）。
	{
		id: "canvas-delete",
		group: "编排画布",
		label: "删除节点 / 断开连线",
		keys: "Delete",
		displayOnly: true,
	},
	// 复制、粘贴、创建副本（editor/node-clipboard.tsx）：焦点在输入框里时仍是文本操作。复制、粘贴不拦按键，
	// 由浏览器的复制、粘贴事件处理（页面上选中的文字照常复制，剪贴板里不是节点时照常粘贴）。
	{ id: "canvas-copy", group: "编排画布", label: "复制节点", keys: "Ctrl+C", displayOnly: true },
	{ id: "canvas-paste", group: "编排画布", label: "粘贴节点", keys: "Ctrl+V", displayOnly: true },
	{ id: "canvas-duplicate", group: "编排画布", label: "创建副本", keys: "Ctrl+D" },
	// 节点菜单（components/canvas/FlowCanvas.tsx）：焦点在节点卡片上时打开，菜单键同样可以。
	{
		id: "canvas-node-menu",
		group: "编排画布",
		label: "打开节点菜单",
		keys: "Shift+F10",
		displayOnly: true,
	},
	{ id: "canvas-fit", group: "编排画布", label: "适配视图", keys: "0" },
	{ id: "canvas-pointer", group: "编排画布", label: "指针", keys: "V" },
	{ id: "canvas-hand", group: "编排画布", label: "抓手", keys: "H" },
	{ id: "canvas-minimap", group: "编排画布", label: "小地图", keys: "M" },
	{ id: "canvas-inspector", group: "编排画布", label: "检查器", keys: "I" },
	{ id: "canvas-chain", group: "编排画布", label: "沿链切换节点", keys: "←/→", displayOnly: true },
	{ id: "canvas-subflow", group: "编排画布", label: "进出子流程", keys: "↓/↑", displayOnly: true },
	{
		id: "canvas-to-inspector",
		group: "编排画布",
		label: "焦点移到检查器",
		keys: "Enter",
		displayOnly: true,
	},
	{ id: "canvas-deselect", group: "编排画布", label: "取消选中", keys: "Esc", displayOnly: true },
	{ id: "monitor-toggle-timeline", group: "运行监控", label: "时间线汇总 / 展开节点", keys: "T" },
	// 运行监控的命令：命令面板按这里的顺序列出，取消排在最后，Ctrl K 之后直接 Enter 不会落到它上面。
	{
		id: "monitor-next-failure",
		group: "运行监控",
		label: "下一个失败的节点",
		keys: "F",
		palette: true,
	},
	{
		id: "monitor-errors-only",
		group: "运行监控",
		label: "只看 ERROR / 恢复级别",
		keys: "E",
		palette: true,
	},
	{
		id: "monitor-follow-live",
		group: "运行监控",
		label: "回到实时 / 重置时间范围",
		keys: "L",
		palette: true,
	},
	{ id: "monitor-rerun", group: "运行监控", label: "再次运行", keys: "R", palette: true },
	{
		id: "monitor-cancel",
		group: "运行监控",
		label: "取消运行 / 强制终止",
		keys: "C",
		palette: true,
	},
	// 取消选中节点（monitor/MonitorPage.tsx）。
	{
		id: "monitor-deselect",
		group: "运行监控",
		label: "取消选中节点",
		keys: "Esc",
		displayOnly: true,
	},
	// 日志行菜单（monitor/LogList.tsx）：合并视图里焦点在日志行上时打开，菜单键同样可以。
	{
		id: "monitor-log-row-menu",
		group: "运行监控",
		label: "打开日志行菜单",
		keys: "Shift+F10",
		displayOnly: true,
	},
	// 列表页（场景、运行记录、节点包）：J / K 在列表项之间移动真实的键盘焦点（components/list-navigation.tsx），
	// / 聚焦搜索框（lib/use-search-input.ts；没有搜索框的页面不绑定）。
	{ id: "list-next", group: "列表页", label: "下一项", keys: "J" },
	{ id: "list-prev", group: "列表页", label: "上一项", keys: "K" },
	{ id: "list-search", group: "列表页", label: "搜索", keys: "/" },
] as const satisfies readonly ShortcutDef[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** 登记了 `palette` 的快捷键：命令面板要给每一个配图标（CommandPalette 的 PAGE_COMMAND_ICON），少一个编译不过。 */
export type PaletteShortcut = Extract<(typeof SHORTCUTS)[number], { palette: true }>;
export type PaletteShortcutId = PaletteShortcut["id"];

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
	return keyChords(keys).flat();
}

declare const keyLabelBrand: unique symbol;

/**
 * 界面上显示的按键文字（`Kbd` 的内容只接受它）。只能从注册表取（shortcutKeys / shortcutText），
 * 或是不登记的操作说明（operationKey），所以 `<Kbd>Ctrl S</Kbd>` 这样写死的按键过不了类型检查。
 */
export type KeyLabel = string & { readonly [keyLabelBrand]: true };

/** 注册表里快捷键的按键标签，按依次按下的组分开（见 keyChords）。 */
export const shortcutKeys = (id: ShortcutId): KeyLabel[][] =>
	keyChords(shortcutById(id).keys) as KeyLabel[][];

/**
 * 写在文字里的快捷键（提示、通知里的「可以撤销（Ctrl Z）」，工具条按钮提示）：从注册表取，按键之间用空格隔开。
 */
export const shortcutText = (id: ShortcutId): KeyLabel =>
	keyLabels(shortcutById(id).keys).join(" ") as KeyLabel;

/**
 * 操作说明里的按键：只说明怎么操作眼前的控件（命令面板底部的「↑ ↓ 选择」），不是快捷键，不登记、不进快捷键面板。
 * 只列在这里的几个键，快捷键不要写成它。
 */
export type OperationKey = "↑" | "↓" | "Enter" | "Esc";
export const operationKey = (key: OperationKey): KeyLabel => key as KeyLabel;

/** 按依次按下的组分开的按键：`G D` → [["G"], ["D"]]；`Ctrl+K` → [["Ctrl", "K"]]（同时按的在一组）。 */
export function keyChords(keys: string): string[][] {
	return keys
		.trim()
		.split(/\s+/)
		.map((chord) => chord.split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k)));
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

	/**
	 * 处理一次按键；匹配到快捷键时返回它的 id。now 为毫秒时间戳。
	 * isBound 说明某个快捷键当前有没有处理函数：没有绑定的不参与匹配，所以不同页面分组可以登记同一个键。
	 */
	handle(input: KeyInput, now: number, isBound: (id: Id) => boolean = () => true): Id | null {
		if (MODIFIER_KEYS.has(input.key.toLowerCase())) return null;
		if (now - this.#lastAt > SEQUENCE_TIMEOUT) this.#pending = [];
		this.#lastAt = now;

		// 先尝试接在已有序列后面，不行再从这个键单独开始。
		for (const sequence of [[...this.#pending, input], [input]]) {
			const usable = this.#defs.filter(
				({ id, def, chords }) =>
					isBound(id) &&
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
