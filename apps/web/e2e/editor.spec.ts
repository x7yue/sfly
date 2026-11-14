// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Locator, Page } from "@playwright/test";
import {
	createEditorScenario,
	dock,
	draftNode,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	nodeMenu,
	openEditor,
	typedDocument,
	typedNodes,
} from "./editor-support";
import { expect, test } from "./fixtures";
import {
	box,
	createScenario,
	expectFocusVisible,
	expectRingPainted,
	publishPackage,
} from "./support";

// 全屏编排画布（原型 #/editor/:id 的编辑模式）：画布与检查器。

const zoomLevel = async (page: Page) =>
	Number((await dock(page).getByLabel("缩放比例").textContent())?.replace("%", ""));

test("全屏画布：不带侧边栏，控件悬浮，打开时适配视图并避开悬浮控件，窗口变化时重新适配", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "日终数据处理" })).toBeVisible();
	await expect(page.getByText("v1", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();
	await expect(page.getByRole("group", { name: "模式" })).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).not.toHaveAttribute("data-status");
	await expect(page.getByRole("link", { name: "版本历史" })).toHaveAttribute(
		"href",
		`/orchestrations/${id}/versions`,
	);
	await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();
	await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
	for (const tool of ["指针", "抓手", "缩小", "放大", "适配视图", "小地图", "检查器"]) {
		await expect(dock(page).getByRole("button", { name: tool })).toBeVisible();
	}
	await expect(page.locator(".react-flow__minimap")).toBeVisible();
	await expect(inspector(page)).toBeVisible();

	// 所有节点都在视口里，且不被顶部控件组、工具条和检查器挡住。
	const expectNodesInFreeArea = async () => {
		const panel = await box(inspector(page));
		const toolbar = await box(dock(page));
		const viewport = page.viewportSize() ?? { width: 0, height: 0 };
		for (const nodeId of ["entry", "fetch", "dispatch", "ping", "sub_entry", "sub_ping"]) {
			const b = await box(nodeCard(page, nodeId));
			expect(b.x).toBeGreaterThan(0);
			expect(b.y).toBeGreaterThan(54);
			expect(b.x + b.width).toBeLessThan(panel.x);
			expect(b.y + b.height).toBeLessThan(Math.min(toolbar.y, viewport.height));
		}
	};
	await expectNodesInFreeArea();

	await page.setViewportSize({ width: 1280, height: 760 });
	await expect
		.poll(async () => (await box(nodeCard(page, "sub_ping"))).x)
		.toBeLessThan((await box(inspector(page))).x - (await box(nodeCard(page, "sub_ping"))).width);
	await expectNodesInFreeArea();

	// 小地图与检查器可以收起。
	await page.keyboard.press("m");
	await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
	await page.keyboard.press("i");
	await expect(inspector(page)).toHaveCount(0);
	await dock(page).getByRole("button", { name: "检查器" }).click();
	await expect(inspector(page)).toBeVisible();
	await inspector(page).getByRole("button", { name: "收起检查器" }).click();
	await expect(inspector(page)).toHaveCount(0);
});

test("选中是中性高亮，只有相连的连线流动；端口常显：已连接实心，链尾虚线", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await expect(nodeCard(page, "fetch")).toHaveAttribute("aria-pressed", "true");
	// --selected，中性灰白，不是青色；描边有 150ms 过渡，用会重试的断言等过渡结束。
	await expect(nodeCard(page, "fetch")).toHaveCSS("border-color", "rgb(212, 212, 212)");

	const highlighted = page.locator('[data-edge][data-highlighted="true"]');
	await expect(highlighted).toHaveCount(2);
	await expect(page.locator('[data-edge="chain:entry->fetch"]')).toHaveAttribute(
		"data-highlighted",
		"true",
	);
	await expect(page.locator('[data-edge="chain:dispatch->ping"]')).toHaveAttribute(
		"data-highlighted",
		"false",
	);
	const animation = await highlighted.first().evaluate((el) => getComputedStyle(el).animationName);
	expect(animation).toBe("edge-flow");

	const port = (nodeId: string, type: "source" | "target", handle = "chain") =>
		nodeCard(page, nodeId).locator(`.react-flow__handle[data-handleid="${handle}"].${type}`);
	await expect(port("fetch", "target")).toHaveAttribute("data-state", "connected");
	await expect(port("fetch", "source")).toHaveAttribute("data-state", "connected");
	// 链尾：可以从这里拖线追加节点。
	await expect(port("ping", "source")).toHaveAttribute("data-state", "open");
	await expect(port("sub_ping", "source")).toHaveAttribute("data-state", "open");
	expect(await port("ping", "source").evaluate((el) => getComputedStyle(el).borderStyle)).toBe(
		"dashed",
	);
	await expect(port("dispatch", "source", "dispatch")).toHaveAttribute("data-state", "connected");
});

test("连续快速点击缩放按钮时每次都生效：上一次的动画没结束，下一次从它的目标继续缩放", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const before = await zoomLevel(page);
	// 同一个事件循环里连点：前一次 150 ms 的动画都还没开始推进。
	const clickTimes = (label: string, times: number) =>
		dock(page)
			.getByRole("button", { name: label })
			.evaluate((button, n) => {
				for (let i = 0; i < n; i++) (button as HTMLButtonElement).click();
			}, times);

	await clickTimes("缩小", 2);
	await expect.poll(() => zoomLevel(page)).toBe(Math.round(before / 1.2 / 1.2));
	await clickTimes("缩小", 12);
	await expect.poll(() => zoomLevel(page)).toBe(30);
	await clickTimes("放大", 2);
	await expect.poll(() => zoomLevel(page)).toBe(Math.round(30 * 1.2 * 1.2));
});

test("语义缩放：缩小后卡片只留关键信息，屏幕上的文字不小于 11px；缩放有下限", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const smallestText = () =>
		page.locator(".react-flow").evaluate((root) => {
			let min = Number.POSITIVE_INFINITY;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const el = n.parentElement;
				if (!el || !n.textContent?.trim() || el.closest(".react-flow__minimap")) continue;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || getComputedStyle(el).display === "none") continue;
				// 屏幕字号 = 字号 × 所在视口的缩放比例
				const zoom = Number(
					getComputedStyle(el.closest("[data-lod]") as Element).getPropertyValue("--canvas-zoom"),
				);
				min = Math.min(min, Number.parseFloat(getComputedStyle(el).fontSize) * zoom);
			}
			return min;
		});

	await expect(nodeCard(page, "fetch").getByText("url = https://example.test/snap")).toBeVisible();
	expect(await smallestText()).toBeGreaterThanOrEqual(10.99);

	for (let i = 0; i < 12; i++) await dock(page).getByRole("button", { name: "缩小" }).click();
	await expect.poll(() => zoomLevel(page)).toBe(30);
	await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
	await expect(nodeCard(page, "fetch").getByText("url = https://example.test/snap")).toBeHidden();
	await expect(nodeCard(page, "fetch").getByText("HTTP 检查")).toBeVisible();
	await expect(page.getByRole("region", { name: "子流程 sub_entry" })).toContainText("sub_entry");
	expect(await smallestText()).toBeGreaterThanOrEqual(10.99);

	await page.keyboard.press("0");
	await expect.poll(() => zoomLevel(page)).toBeGreaterThan(30);
});

async function tabUntil(page: Page, target: Locator, limit = 40) {
	for (let presses = 1; presses <= limit; presses++) {
		await page.keyboard.press("Tab");
		if (await target.evaluate((el) => el === document.activeElement)) return presses;
	}
	throw new Error(`按了 ${limit} 次 Tab 还没到`);
}

test("Tab 顺序：先经过顶栏再进入画布，画布只有画布区域一个停靠点，节点不在 Tab 顺序里", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const canvas = page.getByRole("region", { name: /^编排画布/ });

	// 顶栏在画布前面：「运行」是第 6 个停靠点（返回、检查状态、两个模式按钮、版本历史、运行；保存不可用时跳过）。
	expect(await tabUntil(page, page.getByRole("button", { name: "运行", exact: true }))).toBe(6);
	await page.keyboard.press("Tab");
	await expectFocusVisible(canvas);
	// 画布区域铺满视口，焦点环在内侧的 2px：要画在 React Flow 与悬浮控件上面才看得见。
	await expectRingPainted(page, { x: 1, y: 450 });
	await expectRingPainted(page, { x: 720, y: 898 });
	await page.keyboard.press("Tab");
	await expect(dock(page).getByRole("button", { name: "添加节点" })).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expectFocusVisible(canvas);

	await page.keyboard.press("ArrowRight");
	await expectFocusVisible(nodeCard(page, "entry"));
	await expect(nodeCard(page, "entry")).toHaveAccessibleName("节点 entry，入口");
	await page.keyboard.press("ArrowRight");
	await expectFocusVisible(nodeCard(page, "fetch"));
	await expect(nodeCard(page, "fetch")).toHaveAccessibleName("节点 fetch，HTTP 检查");
	await expect(nodeCard(page, "sub_entry")).toHaveAccessibleName("节点 sub_entry，子流程入口");
	await expect(page.getByRole("img", { name: "调度连线：从 dispatch 到 sub_entry" })).toHaveCount(
		1,
	);

	await page.keyboard.press("Shift+F10");
	// 菜单出现后 Base UI 才把焦点移进菜单：等焦点到位再按键，否则 Esc 会落在节点上。
	await expect(nodeMenu(page)).toBeFocused();
	await page.keyboard.press("Escape");
	await expectFocusVisible(nodeCard(page, "fetch"));
	await page.keyboard.press("Escape");
	await expectFocusVisible(canvas);
	await page.keyboard.press("Tab");
	await expect(dock(page).getByRole("button", { name: "添加节点" })).toBeFocused();
});

test("键盘浏览：方向键沿链切换，↓ / ↑ 进出子流程，Enter 到检查器，Esc 取消选中；方向键不移动节点", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const selected = page.locator('[data-node-id][aria-pressed="true"]');
	const before = await box(nodeCard(page, "fetch"));

	await page.keyboard.press("ArrowRight");
	await expect(selected).toHaveAttribute("data-node-id", "entry");
	await page.keyboard.press("ArrowRight");
	await expect(selected).toHaveAttribute("data-node-id", "fetch");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await expect(inspector(page).getByRole("heading", { name: "HTTP 检查" })).toBeVisible();
	expect(await box(nodeCard(page, "fetch"))).toEqual(before);

	await page.keyboard.press("ArrowRight");
	await expect(selected).toHaveAttribute("data-node-id", "dispatch");
	await page.keyboard.press("ArrowDown");
	await expect(selected).toHaveAttribute("data-node-id", "sub_entry");
	await page.keyboard.press("ArrowRight");
	await expect(selected).toHaveAttribute("data-node-id", "sub_ping");
	await page.keyboard.press("ArrowRight");
	await expect(selected).toHaveAttribute("data-node-id", "sub_ping");
	await page.keyboard.press("ArrowUp");
	await expect(selected).toHaveAttribute("data-node-id", "dispatch");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(selected).toHaveAttribute("data-node-id", "fetch");

	// Enter：焦点移到检查器的第一个字段；Esc：回到画布上的节点；再按 Esc 取消选中。
	await page.keyboard.press("Enter");
	await expect(inspector(page).getByRole("combobox", { name: "输入 url" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expectFocusVisible(nodeCard(page, "fetch"));
	await page.keyboard.press("Escape");
	await expect(selected).toHaveCount(0);
	// 取消选中后焦点留在画布上，焦点环可见。
	await expectFocusVisible(page.getByRole("region", { name: /^编排画布/ }));
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
	expect(await box(nodeCard(page, "fetch"))).toEqual(before);
});

test("检查器：字符串参数只有一个输入框，输入 $ 或点「插入引用」补全，引用整块高亮、整块删除；补全不拦截画布缩放", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "ping").click();
	const panel = inspector(page);
	await expect(panel.getByRole("tab")).toHaveText(["参数", "执行", "说明与指标"]);

	// ping.host 是整值引用：没有模式切换，输入框里就是这个引用，高亮成一块；打开不算修改。
	await expect(panel.getByRole("group", { name: "host 的取值方式" })).toHaveCount(0);
	const host = panel.getByRole("combobox", { name: "输入 host" });
	await expect(host).toHaveText("${{ nodes.fetch.outputs.status }}");
	await expect(host.locator("[data-reference]")).toHaveText(["${{ nodes.fetch.outputs.status }}"]);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);

	// 光标在引用后面，退格一次整块删除。
	await host.click();
	await page.keyboard.press("Control+End");
	await page.keyboard.press("Backspace");
	// 空的输入框显示占位文字。
	await expect(host).toHaveText("必填");

	// 输入 $ 弹出补全，按入口参数 / 前序节点分组。
	await page.keyboard.type("$");
	const list = panel.getByRole("listbox", { name: "可引用的值" });
	await expect(list.getByRole("group")).toHaveText([/^入口参数/, /^前序节点/]);
	await expect(list.getByRole("group", { name: "入口参数" }).getByRole("option")).toHaveText([
		/params\.biz_date\s*string/,
		/params\.api_token\s*string · 敏感/,
	]);
	await expect(list.getByRole("group", { name: "前序节点" }).getByRole("option")).toHaveText([
		/nodes\.fetch\.outputs\.status\s*integer · fetch/,
		/nodes\.dispatch\.outputs\.chain_instance_id\s*dispatch/,
	]);

	// 补全列表打开时，滚轮照常缩放画布，列表不关闭。
	const zoom = await zoomLevel(page);
	const canvas = await box(nodeCard(page, "entry"));
	await page.mouse.move(canvas.x + 20, canvas.y - 40);
	await page.mouse.wheel(0, 300);
	await expect.poll(() => zoomLevel(page)).toBeLessThan(zoom);
	await expect(list).toBeVisible();

	// Esc 只关掉补全，焦点留在输入框里；继续输入又弹出。
	await page.keyboard.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(host).toBeFocused();
	await page.keyboard.type("biz");
	await expect(list.getByRole("option")).toHaveText([/params\.biz_date/]);
	// 输入 $ 触发的补全不预选：用方向键选中后 Enter 才插入。
	await expect(list.getByRole("option", { selected: true })).toHaveCount(0);
	await page.keyboard.press("ArrowDown");
	await expect(list.getByRole("option", { selected: true })).toHaveText(/params\.biz_date/);
	await page.keyboard.press("Enter");
	await expect(host).toHaveText("${{ params.biz_date }}");
	await expect(list).toHaveCount(0);

	// 切到 fetch：文字和引用混写。「插入引用」弹出同样的补全，选中的引用插在光标处。
	await nodeCard(page, "fetch").click();
	const url = panel.getByRole("combobox", { name: "输入 url" });
	await expect(url).toHaveText("https://example.test/snap");
	await expect(url.locator("[data-reference]")).toHaveCount(0);
	await url.fill("https://example.test/?d=");
	await panel.getByRole("button", { name: "在 url 中插入引用" }).click();
	await expect(url).toBeFocused();
	// fetch 是链上第一个节点：只有入口参数可以引用。「插入引用」打开的补全预选第一项。
	await expect(list.getByRole("option")).toHaveText([/params\.biz_date/, /params\.api_token/]);
	await expect(list.getByRole("option", { selected: true })).toHaveText(/params\.biz_date/);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("Enter");
	await expect(url).toHaveText("https://example.test/?d=${{ params.biz_date }}");
	// 光标停在引用后面：接着写文字，再把光标移到最前面用 ${{ 插入一个引用。
	await page.keyboard.type("&x=1");
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("${{ api");
	await list.getByRole("option", { name: /params\.api_token/ }).click();
	await expect(url).toHaveText(
		"${{ params.api_token }}https://example.test/?d=${{ params.biz_date }}&x=1",
	);
	await expect(url.locator("[data-reference]")).toHaveText([
		"${{ params.api_token }}",
		"${{ params.biz_date }}",
	]);
	// 刚插入的引用后面退格：整块删除。
	await page.keyboard.press("Backspace");
	await expect(url).toHaveText("https://example.test/?d=${{ params.biz_date }}&x=1");
	// 写普通的 $ 不受影响：没有匹配的引用时不弹出。
	await page.keyboard.type("$HOME ");
	await expect(list).toHaveCount(0);
	await expect(url).toHaveText("$HOME https://example.test/?d=${{ params.biz_date }}&x=1");

	await expect(page.getByText("有未保存的修改")).toBeVisible();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.number).toBe(2);
	// 整个值恰好是一个引用：整值引用；混写：内嵌引用。都是原来的字符串格式。
	expect(head.document.nodes.find((n) => n.id === "ping")?.inputs).toEqual({
		host: "${{ params.biz_date }}",
	});
	expect(head.document.nodes.find((n) => n.id === "fetch")?.inputs).toEqual({
		url: "$HOME https://example.test/?d=${{ params.biz_date }}&x=1",
	});
});

test("检查器：$HOME 这样的写法匹配到候选时，Enter 和 Tab 不插入引用；方向键或鼠标选中后才插入", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const url = panel.getByRole("combobox", { name: "输入 url" });
	const list = panel.getByRole("listbox", { name: "可引用的值" });

	// $b 匹配到 params.biz_date：补全弹出，但没有选中项，Enter 照常换行。
	await url.fill("echo ");
	await page.keyboard.type("$b");
	await expect(list.getByRole("option")).toHaveText([/params\.biz_date/]);
	await expect(list.getByRole("option", { selected: true })).toHaveCount(0);
	await page.keyboard.press("Enter");
	await page.keyboard.type("x");
	await expect(url.locator(".cm-line")).toHaveText(["echo $b", "x"]);
	await expect(url.locator("[data-reference]")).toHaveCount(0);

	// Tab 也不插入，焦点照常移到下一个控件。
	await url.fill("echo ");
	await page.keyboard.type("$b");
	await expect(list.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Tab");
	await expect(url).not.toBeFocused();
	await expect(url).toHaveText("echo $b");
	await expect(list).toHaveCount(0);

	// 方向键选中后 Tab 插入；继续输入后选中项清掉，要重新选。
	await url.fill("echo ");
	await page.keyboard.type("$");
	await page.keyboard.press("ArrowUp");
	await expect(list.getByRole("option", { selected: true })).toHaveText(/params\.api_token/);
	await page.keyboard.type("b");
	await expect(list.getByRole("option", { selected: true })).toHaveCount(0);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Tab");
	await expect(url).toHaveText("echo ${{ params.biz_date }}");
	await expect(url).toBeFocused();

	// 鼠标点选不需要先用方向键。
	await page.keyboard.type(" $a");
	await list.getByRole("option", { name: /params\.api_token/ }).click();
	await expect(url).toHaveText("echo ${{ params.biz_date }} ${{ params.api_token }}");
});

test("检查器：非字符串参数没有模式切换；「插入引用」选中后显示引用标签，点 × 回到类型控件", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes: typedNodes });
	const id = await createScenario(controlPlane, "各种类型的参数", typedDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "typed").click();
	const panel = inspector(page);
	const list = panel.getByRole("listbox", { name: "可引用的值" });
	const chip = (name: string) => panel.getByRole("group", { name: `输入 ${name}` });

	// 界面上没有「常量 / 引用」切换。
	await expect(panel.getByRole("button", { name: "常量", exact: true })).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "引用", exact: true })).toHaveCount(0);

	// 旧场景里的整值引用（count）直接显示为引用标签；常量显示类型控件。打开不算修改。
	await expect(chip("count")).toHaveText("${{ nodes.probe.outputs.status }}");
	await expect(panel.getByRole("textbox", { name: "输入 count" })).toHaveCount(0);
	await expect(panel.getByRole("textbox", { name: "输入 ratio" })).toHaveValue("0.5");
	await expect(panel.getByRole("combobox", { name: "输入 strict" })).toHaveValue("true");
	await expect(panel.getByRole("combobox", { name: "输入 level" })).toHaveValue('"low"');
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);

	// 点 ×：回到整数输入框，焦点跟过去；这个输入不再写进文档。
	await chip("count").getByRole("button", { name: "移除 count 的引用" }).click();
	const count = panel.getByRole("textbox", { name: "输入 count" });
	await expect(count).toBeFocused();
	await expect(count).toHaveValue("");
	await expect(chip("count")).toHaveCount(0);

	// 整数框里没生效的输入（abc）被引用整个换掉，不再阻止保存。
	await count.fill("abc");
	await count.blur();
	await expect(page.getByText("1 处字段错误")).toBeVisible();
	const insert = panel.getByRole("button", { name: "在 count 中插入引用" });
	await insert.click();
	await expect(list.getByRole("group")).toHaveText([/^入口参数/, /^前序节点/]);
	await list.getByRole("option", { name: /params\.n/ }).click();
	await expect(chip("count")).toHaveText("${{ params.n }}");
	await expect(page.getByText("1 处字段错误")).toHaveCount(0);
	await expect(list).toHaveCount(0);

	// 键盘：焦点在「插入引用」上，Enter 打开，方向键选择，Esc 只关掉补全，Enter 确认后焦点到标签的 ×。
	const insertStrict = panel.getByRole("button", { name: "在 strict 中插入引用" });
	await insertStrict.focus();
	await page.keyboard.press("Enter");
	await expect(list).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(insertStrict).toBeFocused();
	await page.keyboard.press("Enter");
	await page.keyboard.press("ArrowDown");
	await expect(list.getByRole("option", { selected: true })).toHaveText(/params\.flag/);
	await page.keyboard.press("Enter");
	await expect(chip("strict")).toHaveText("${{ params.flag }}");
	await expect(panel.getByRole("button", { name: "移除 strict 的引用" })).toBeFocused();
	// × 回到下拉选择。
	await page.keyboard.press("Enter");
	await expect(panel.getByRole("combobox", { name: "输入 strict" })).toBeFocused();
	await expect(panel.getByRole("combobox", { name: "输入 strict" })).toHaveValue("");

	// 枚举：选引用；无效的引用照常在字段下警告。
	await panel.getByRole("button", { name: "在 level 中插入引用" }).click();
	await list.getByRole("option", { name: /nodes\.probe\.outputs\.status/ }).click();
	await expect(chip("level")).toHaveText("${{ nodes.probe.outputs.status }}");

	// JSON：同一个编辑器内核，多行、等宽；字符串值里可以内嵌引用并高亮。
	const options = panel.getByRole("combobox", { name: "输入 options" });
	await expect(options.locator(".cm-line")).toHaveText(["{", '"retries": 2', "}"]);
	await expect(options).toHaveCSS("font-family", /JetBrains Mono/);
	await options.fill('{"date": "');
	await options.blur();
	await expect(panel.getByText("不是合法的 JSON")).toBeVisible();
	await panel.getByRole("button", { name: "在 options 中插入引用" }).click();
	await list.getByRole("option", { name: /params\.n/ }).click();
	await page.keyboard.type('"}');
	await expect(options).toHaveText('{"date": "${{ params.n }}"}');
	await expect(options.locator("[data-reference]")).toHaveText(["${{ params.n }}"]);
	await expect(panel.getByText("不是合法的 JSON")).toHaveCount(0);

	// JSON 字段整个文本恰好是一个引用：就是整值引用，显示为引用标签。
	const payload = panel.getByRole("combobox", { name: "输入 payload" });
	await payload.click();
	await panel.getByRole("button", { name: "在 payload 中插入引用" }).click();
	await page.keyboard.press("Enter");
	await expect(chip("payload")).toHaveText("${{ params.n }}");
	await expect(panel.getByRole("button", { name: "移除 payload 的引用" })).toBeFocused();
	// 撤销回到类型控件，重做又是引用标签。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(chip("payload")).toHaveCount(0);
	await expect(payload).toBeVisible();
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(chip("payload")).toHaveText("${{ params.n }}");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	// 保存的格式不变：整值引用是字符串 `${{ … }}`，常量保持原类型。
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "typed")?.inputs,
	).toEqual({
		count: "${{ params.n }}",
		ratio: 0.5,
		level: "${{ nodes.probe.outputs.status }}",
		options: { date: "${{ params.n }}" },
		payload: "${{ params.n }}",
	});
});

test("异步任务参数映射、Sleep 时长、入口参数默认值用同一种输入框；敏感参数的默认值仍是密码框", async ({
	page,
	controlPlane,
}) => {
	// 在子流程末尾加一个 Sleep 节点 wait。
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", {
		...editorDocument,
		nodes: [
			...editorDocument.nodes,
			{ id: "wait", kind: "sleep", duration: "5s", position: { x: 1164, y: 230 } },
		],
		edges: [...editorDocument.edges, { from: "sub_ping", to: "wait", kind: "chain" }],
	});
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "wait")).toBeVisible();
	const panel = inspector(page);
	const list = panel.getByRole("listbox", { name: "可引用的值" });

	// 异步任务节点的参数映射：已有的引用高亮；输入 $ 补全，「插入引用」插在光标处。
	await nodeCard(page, "dispatch").click();
	const date = panel.getByRole("combobox", { name: "子流程参数 date" });
	await expect(date).toHaveText("${{ params.biz_date }}");
	await expect(date.locator("[data-reference]")).toHaveCount(1);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await date.click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("-$api");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(date).toHaveText("${{ params.biz_date }}-${{ params.api_token }}");
	await page.keyboard.press("Backspace");
	await panel.getByRole("button", { name: "在 date 中插入引用" }).click();
	await page.keyboard.press("Enter");
	await expect(date).toHaveText("${{ params.biz_date }}-${{ params.biz_date }}");
	await expect(panel.getByRole("button", { name: "放大编辑 date" })).toBeVisible();

	// 入口参数默认值：同一种输入框，但默认值是字面量，不弹补全、不高亮；敏感参数仍是密码框。
	await nodeCard(page, "entry").click();
	const bizDate = panel.getByRole("group", { name: "参数 biz_date" });
	const fallback = bizDate.getByRole("combobox", { name: "默认值" });
	await fallback.click();
	await page.keyboard.type("$b");
	await expect(list).toHaveCount(0);
	await fallback.fill("${{ params.x }}\n第二行");
	await expect(fallback.locator("[data-reference]")).toHaveCount(0);
	await expect(fallback.locator(".cm-line")).toHaveCount(2);
	await expect(bizDate.getByRole("button", { name: "放大编辑 biz_date" })).toBeVisible();
	const token = panel.getByRole("group", { name: "参数 api_token" });
	await expect(token.getByLabel("默认值", { exact: true })).toHaveAttribute("type", "password");
	await expect(token.locator('[data-slot="reference-editor"]')).toHaveCount(0);
	await expect(token.getByRole("button", { name: /放大编辑/ })).toHaveCount(0);
	// 数字和 JSON 默认值照常解析：不合法时阻止保存。
	await bizDate.getByLabel("参数类型").selectOption("number");
	const numeric = bizDate.getByRole("combobox", { name: "默认值" });
	await numeric.fill("abc");
	await numeric.blur();
	await expect(bizDate.getByText("需要数字")).toBeVisible();
	await numeric.fill("7");
	await expect(bizDate.getByText("需要数字")).toHaveCount(0);
	await bizDate.getByLabel("参数类型").selectOption("string");
	await bizDate.getByRole("combobox", { name: "默认值" }).fill("2026-01-02");

	// Sleep 节点的等待时长：输入框旁有「插入引用」，常用时长照常可用。
	await nodeCard(page, "wait").click();
	const duration = panel.getByRole("combobox", { name: "等待时长" });
	await expect(duration).toHaveText("5s");
	await duration.fill("");
	await panel.getByRole("button", { name: "在 等待时长 中插入引用" }).click();
	await expect(list.getByRole("option")).toHaveText([
		/params\.date/,
		/nodes\.sub_ping\.outputs\.alive/,
	]);
	await page.keyboard.press("Enter");
	await expect(duration).toHaveText("${{ params.date }}");
	await expect(panel.getByText("执行时解析引用")).toBeVisible();
	await panel.getByRole("group", { name: "常用时长" }).getByRole("button", { name: "10m" }).click();
	await expect(duration).toHaveText("10m");
	await duration.fill("${{ params.date }}");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const nodes = (await headOf(controlPlane, id)).document.nodes as unknown as Record<
		string,
		unknown
	>[];
	expect(nodes.find((n) => n.id === "dispatch")?.params).toEqual({
		date: "${{ params.biz_date }}-${{ params.biz_date }}",
	});
	expect(nodes.find((n) => n.id === "entry")?.params).toMatchObject([
		{ name: "biz_date", type: "string", default: "2026-01-02" },
		{ name: "api_token", default: "s3cr3t", secret: true },
	]);
	expect(nodes.find((n) => n.id === "wait")).toMatchObject({ duration: "${{ params.date }}" });
});

test("放大编辑：等宽的大弹窗里有补全和高亮，锁定焦点，Esc 先关补全再关弹窗；修改进入撤销历史和本地草稿", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const url = panel.getByRole("combobox", { name: "输入 url" });
	const open = panel.getByRole("button", { name: "放大编辑 url" });
	// 数字参数没有放大编辑。
	await expect(panel.getByRole("button", { name: "放大编辑 expect" })).toHaveCount(0);
	const small = await box(url);

	await open.click();
	const dialog = page.getByRole("dialog", { name: "编辑 url" });
	const big = dialog.getByRole("combobox", { name: "输入 url（放大编辑）" });
	const list = dialog.getByRole("listbox", { name: "可引用的值" });
	// 打开时焦点在弹窗的输入框里，内容与检查器里的相同；等宽字体，比检查器里的输入框大得多。
	await expect(big).toBeFocused();
	await expect(big).toHaveText("https://example.test/snap");
	await expect(big).toHaveCSS("font-family", /JetBrains Mono/);
	expect((await box(big)).width).toBeGreaterThan(3 * small.width);
	expect((await box(big)).height).toBeGreaterThan(300);

	// 弹窗里输入：多行、$ 补全、引用高亮；检查器里的值同步。
	await page.keyboard.press("Control+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("date=$biz");
	await expect(list.getByRole("option")).toHaveText([/params\.biz_date/]);
	// 补全打开时 Esc 只关掉补全，弹窗还在。
	await page.keyboard.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(big).toBeFocused();
	await page.keyboard.type("_");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(big.locator(".cm-line")).toHaveText([
		"https://example.test/snap",
		"date=${{ params.biz_date }}",
	]);
	await expect(big.locator("[data-reference]")).toHaveText(["${{ params.biz_date }}"]);
	// 弹窗里的「插入引用」。
	await dialog.getByRole("button", { name: "在 url 中插入引用" }).click();
	await list.getByRole("option", { name: /params\.api_token/ }).click();
	await expect(big.locator("[data-reference]")).toHaveCount(2);

	// 锁定焦点：Tab 在弹窗里循环，不会跑到背后的检查器和画布。
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press("Tab");
		// 走到末尾时焦点先落在弹窗的哨兵元素上，随即回到弹窗里的第一个控件。
		await expect
			.poll(() =>
				page.evaluate(
					() => document.activeElement?.closest('[data-slot="dialog-content"]') !== null,
				),
			)
			.toBe(true);
	}
	// 一圈之后回到输入框。
	await expect(dialog.locator(":focus")).toHaveCount(1);

	// Esc 关闭弹窗，焦点回到「放大编辑」按钮；检查器还开着，值已同步。
	await big.click();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(open).toBeFocused();
	await expect(url.locator(".cm-line")).toHaveText([
		"https://example.test/snap",
		"date=${{ params.biz_date }}${{ params.api_token }}",
	]);
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	// 本地草稿：刷新后还在。
	await expect
		.poll(() => draftNode(page, id, "fetch"))
		.toMatchObject({
			inputs: {
				url: "https://example.test/snap\ndate=${{ params.biz_date }}${{ params.api_token }}",
			},
		});
	await page.reload();
	await nodeCard(page, "fetch").click();
	await expect(url.locator("[data-reference]")).toHaveCount(2);

	// 撤销历史：弹窗里的修改可以在画布上撤销。
	await open.click();
	await expect(big).toBeFocused();
	await page.keyboard.press("Control+a");
	await page.keyboard.type("echo zoomed");
	await dialog.getByRole("button", { name: "完成" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(url).toHaveText("echo zoomed");
	const undo = dock(page).getByRole("button", { name: "撤销" });
	await undo.click();
	await expect(url.locator("[data-reference]")).toHaveCount(2);
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(url).toHaveText("echo zoomed");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "fetch")?.inputs,
	).toEqual({ url: "echo zoomed" });
});

test("放大编辑 JSON 字段：写了一半的 JSON 在弹窗里提示，不写进文档；改对后生效", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes: typedNodes });
	const id = await createScenario(controlPlane, "各种类型的参数", typedDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "typed").click();
	const panel = inspector(page);
	await panel.getByRole("button", { name: "放大编辑 options" }).click();
	const dialog = page.getByRole("dialog", { name: "编辑 options" });
	const big = dialog.getByRole("combobox", { name: "输入 options（放大编辑）" });
	await expect(big.locator(".cm-line")).toHaveText(["{", '"retries": 2', "}"]);
	await big.fill('{"retries": 3,');
	await big.blur();
	await expect(dialog.getByText("不是合法的 JSON")).toBeVisible();
	await expect(page.getByText("1 处字段错误")).toBeVisible();
	await big.focus();
	await page.keyboard.type(' "host": "${{ params.n }}"}');
	await expect(dialog.getByText("不是合法的 JSON")).toHaveCount(0);
	await expect(big.locator("[data-reference]")).toHaveText(["${{ params.n }}"]);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "输入 options" })).toHaveText(
		'{"retries": 3, "host": "${{ params.n }}"}',
	);
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "typed")?.inputs,
	).toMatchObject({ options: { retries: 3, host: "${{ params.n }}" } });
});

test("检查器：字符串输入框随内容增高，最多 8 行；无效的引用在字段下警告；清空就是不填", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const url = panel.getByRole("combobox", { name: "输入 url" });
	const frame = panel.locator('[data-slot="reference-editor"]').filter({
		has: page.getByRole("combobox", { name: "输入 url" }),
	});
	const height = async () => (await box(frame)).height;
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join("\n");

	const one = await height();
	await url.fill(lines(3));
	const three = await height();
	expect(three).toBeGreaterThan(one);
	await url.fill(lines(8));
	const eight = await height();
	expect(eight).toBeGreaterThan(three);
	// 超过 8 行不再增高，在输入框内部滚动。
	await url.fill(lines(20));
	await expect.poll(height).toBe(eight);
	// 一行很长的命令自动换行，也会增高。
	await url.fill("curl ".repeat(40));
	await expect.poll(height).toBeGreaterThan(one);

	// 引用了不存在的节点：字段下显示静态检查的警告，不阻止保存。
	await url.fill("${{ nodes.nope.outputs.x }}");
	await expect(panel.getByText("引用了不存在的节点 nope")).toBeVisible();
	await expect(url).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("button", { name: /保存/ })).toBeEnabled();

	// 修改进入本地草稿：刷新后还在。
	await expect
		.poll(() => draftNode(page, id, "fetch"))
		.toMatchObject({ inputs: { url: "${{ nodes.nope.outputs.x }}" } });
	await page.reload();
	await nodeCard(page, "fetch").click();
	await expect(url).toHaveText("${{ nodes.nope.outputs.x }}");
	await expect(panel.getByText("引用了不存在的节点 nope")).toBeVisible();

	// 清空后这个输入不再写进文档。
	await url.fill("");
	await expect(url).toHaveText("必填");
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "fetch")?.inputs).toEqual({});
});

test("字段校验失败时不能保存：保存按钮和 Ctrl S 都把焦点放到出错的字段；改正后可以保存", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const expectInput = panel.getByRole("textbox", { name: "输入 expect" });
	await expectInput.fill("abc");
	await expectInput.blur();
	await expect(panel.getByText("需要整数")).toBeVisible();
	await expect(expectInput).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByText("1 处字段错误")).toBeVisible();
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();
	await expect(page.getByRole("button", { name: "检查通过" })).toHaveCount(0);
	await page.keyboard.press("Control+s");
	await expect(expectInput).toBeFocused();

	// 切换节点后错误仍在（没生效的输入不丢），回来时还显示。
	await nodeCard(page, "entry").click();
	await nodeCard(page, "fetch").click();
	await expect(expectInput).toHaveValue("abc");

	// 执行页的超时也要是正整数；参数名不合法同样阻止保存。
	await panel.getByRole("tab", { name: "执行" }).click();
	await panel.getByLabel("超时", { exact: true }).fill("0");
	await panel.getByLabel("超时", { exact: true }).blur();
	await expect(panel.getByText("需要正整数")).toBeVisible();
	await expect(page.getByText("2 处字段错误")).toBeVisible();
	await panel.getByLabel("超时", { exact: true }).fill("30");
	await panel.getByRole("tab", { name: "参数" }).click();
	await expectInput.fill("404");
	await expect(page.getByText("有未保存的修改")).toBeVisible();
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();

	await nodeCard(page, "entry").click();
	const name = panel.getByRole("textbox", { name: "参数名称" }).first();
	await name.fill("1st");
	await name.blur();
	await expect(panel.getByText("参数名只能包含字母、数字和下划线，不能以数字开头")).toBeVisible();
	// 保存按钮不因校验禁用：点它不保存，焦点到出错的字段。
	await expect(page.getByRole("button", { name: /保存/ })).toBeEnabled();
	await nodeCard(page, "fetch").click();
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(name).toBeFocused();
	await expect(page.getByText("已保存为版本 2")).toHaveCount(0);
	await name.fill("biz_date");

	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const fetch = (await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "fetch");
	expect(fetch).toMatchObject({ inputs: { expect: 404 }, timeout: 30 });
});

test("撤销到已保存的状态：字段、顶栏和节点卡片说的是同一件事；重做回到撤销前", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const expectInput = panel.getByRole("textbox", { name: "输入 expect" });
	await expect(expectInput).toHaveValue("");

	// 1 和 1. 是合法的整数，写进了文档；1.5 起不是，只留在输入框里。
	await expectInput.click();
	await page.keyboard.type("1.5x");
	await expectInput.blur();
	await expect(expectInput).toHaveValue("1.5x");
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();

	await page.keyboard.press("Control+z");
	await expect(expectInput).toHaveValue("");
	await expect(expectInput).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await expect(page.getByText("处字段错误")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();
	await expect(nodeCard(page, "fetch")).not.toContainText("expect");

	await page.keyboard.press("Control+Shift+z");
	await expect(expectInput).toHaveValue("1.5x");
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();
	await expect(panel.getByText("需要整数")).toBeVisible();
});

test("敏感参数的默认值隐藏显示，可以临时显示；取消「敏感」需要二次确认", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "entry").click();
	const token = inspector(page).getByRole("group", { name: "参数 api_token" });
	const value = token.getByLabel("默认值", { exact: true });
	await expect(value).toHaveAttribute("type", "password");
	await expect(value).toHaveValue("s3cr3t");
	await token.getByRole("button", { name: "临时显示默认值" }).click();
	await expect(value).toHaveAttribute("type", "text");
	// 5 秒后自动隐藏。
	await expect(value).toHaveAttribute("type", "password", { timeout: 8_000 });

	const secret = token.getByRole("switch", { name: "敏感" });
	await secret.click();
	const confirm = page.getByRole("dialog", { name: "取消参数 api_token 的「敏感」标记？" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "保持敏感" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(secret).toBeChecked();

	await secret.click();
	await confirm.getByRole("button", { name: "取消敏感标记" }).click();
	await expect(secret).not.toBeChecked();
	// 不再敏感：换成普通的输入框，明文显示。
	await expect(token.getByRole("combobox", { name: "默认值" })).toHaveText("s3cr3t");
	await expect(token.locator('input[type="password"]')).toHaveCount(0);
	await expect(token.getByRole("button", { name: "临时显示默认值" })).toHaveCount(0);
});

test("本地草稿：未保存的修改刷新后还在，保存后清除；Ctrl S 保存", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "sub_ping").click();
	await inspector(page).getByRole("tab", { name: "执行" }).click();
	await inspector(page).getByRole("switch", { name: "always" }).click();
	await expect(nodeCard(page, "sub_ping").getByText("always")).toBeVisible();
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	await expect.poll(() => draftNode(page, id, "sub_ping")).toMatchObject({ always: true });
	await page.reload();
	await expect(nodeCard(page, "sub_ping").getByText("always")).toBeVisible();
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	await nodeCard(page, "sub_ping").click();
	await inspector(page).getByRole("combobox", { name: "输入 host" }).focus();
	await page.keyboard.press("Control+s"); // 焦点在输入框里也能保存
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await page.reload();
	await expect(nodeCard(page, "sub_ping").getByText("always")).toBeVisible();
	await expect(page.getByText("v2", { exact: true })).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
});
