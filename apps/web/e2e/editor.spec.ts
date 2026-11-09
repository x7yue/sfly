// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Locator, Page } from "@playwright/test";
import { createEditorScenario, headOf, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { expectFocusVisible } from "./support";

// 全屏编排画布（原型 #/editor/:id 的编辑模式）：画布与检查器。

const inspector = (page: Page) => page.getByRole("complementary", { name: "检查器" });
const dock = (page: Page) => page.getByRole("toolbar", { name: "画布工具" });
const zoomLevel = async (page: Page) =>
	Number((await dock(page).getByLabel("缩放比例").textContent())?.replace("%", ""));

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error("元素不可见");
	return b;
}

async function openEditor(page: Page, id: string) {
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "sub_ping")).toBeVisible();
	// 等打开时的适配视图完成（节点位置不再变化）。
	await expect
		.poll(async () => JSON.stringify(await nodeCard(page, "entry").boundingBox()))
		.toBe(JSON.stringify(await nodeCard(page, "entry").boundingBox()));
}

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

test("检查器：按输入 schema 生成表单，常量 / 引用切换，引用补全按入口参数与前序节点分组；补全不拦截画布缩放", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "ping").click();
	const panel = inspector(page);
	await expect(panel.getByRole("tab")).toHaveText(["参数", "执行", "说明与指标"]);

	// ping.host 是整值引用：打开时就是引用模式。
	await expect(panel.getByRole("button", { name: "引用", pressed: true })).toBeVisible();
	const host = panel.getByRole("combobox", { name: "输入 host" });
	await expect(host).toHaveValue("nodes.fetch.outputs.status");
	await host.fill("");
	await host.focus();
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

	await host.pressSequentially("biz");
	await expect(list.getByRole("option")).toHaveText([/params\.biz_date/]);
	await page.keyboard.press("Enter");
	await expect(host).toHaveValue("params.biz_date");
	await expect(list).toHaveCount(0);

	// 切到 fetch：字符串常量里输入 ${{ 也弹出补全，选中的引用插在光标处。
	await nodeCard(page, "fetch").click();
	const url = panel.getByRole("combobox", { name: "输入 url" });
	await url.fill("https://example.test/");
	await url.pressSequentially("${{ par");
	await list.getByRole("option", { name: /params\.biz_date/ }).click();
	await expect(url).toHaveValue("https://example.test/${{ params.biz_date }}");
	// 整数输入可以切到引用。
	await panel
		.getByRole("group", { name: "expect 的取值方式" })
		.getByRole("button", { name: "引用" })
		.click();
	await panel.getByRole("combobox", { name: "输入 expect" }).focus();
	await expect(list.getByRole("group", { name: "前序节点" })).toHaveCount(0);

	await expect(page.getByText("有未保存的修改")).toBeVisible();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.number).toBe(2);
	expect(head.document.nodes.find((n) => n.id === "ping")?.inputs).toEqual({
		host: "${{ params.biz_date }}",
	});
	expect(head.document.nodes.find((n) => n.id === "fetch")?.inputs).toEqual({
		url: "https://example.test/${{ params.biz_date }}",
	});
});

test("字段校验失败时不能保存：按钮禁用，Ctrl S 提示；改正后可以保存", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	const expectInput = panel.getByRole("textbox", { name: "输入 expect" });
	await expectInput.fill("abc");
	await expect(panel.getByText("需要整数")).toBeVisible();
	await expect(expectInput).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByText("1 处字段错误")).toBeVisible();
	await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("有 1 处字段错误，改正后才能保存")).toBeVisible();

	// 切换节点后错误仍在（没生效的输入不丢），回来时还显示。
	await nodeCard(page, "entry").click();
	await nodeCard(page, "fetch").click();
	await expect(expectInput).toHaveValue("abc");

	// 执行页的超时也要是正整数；参数名不合法同样阻止保存。
	await panel.getByRole("tab", { name: "执行" }).click();
	await panel.getByLabel("超时", { exact: true }).fill("0");
	await expect(panel.getByText("需要正整数")).toBeVisible();
	await expect(page.getByText("2 处字段错误")).toBeVisible();
	await panel.getByLabel("超时", { exact: true }).fill("30");
	await panel.getByRole("tab", { name: "参数" }).click();
	await expectInput.fill("404");
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	await nodeCard(page, "entry").click();
	const name = panel.getByRole("textbox", { name: "参数名称" }).first();
	await name.fill("1st");
	await expect(panel.getByText("参数名只能包含字母、数字和下划线，不能以数字开头")).toBeVisible();
	await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();
	await name.fill("biz_date");

	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const fetch = (await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "fetch");
	expect(fetch).toMatchObject({ inputs: { expect: 404 }, timeout: 30 });
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
	await expect(value).toHaveAttribute("type", "text");
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

	await page.waitForTimeout(400); // 草稿写入有 300ms 防抖
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
