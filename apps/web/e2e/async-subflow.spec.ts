import type { Locator, Page } from "@playwright/test";
import {
	addMenu,
	createEditorScenario,
	dock,
	edge,
	headOf,
	nodeCard,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, overlap } from "./support";

// 新建子流程一步完成（#187）：添加异步任务节点时勾选「同时新建子流程」，或从异步任务节点的调度端口拖线到空白处，
// 一次得到子流程入口节点和调度连线；名称的检查与新建子流程入口一致，整个操作是一步撤销。

const region = (page: Page, name: string) => page.getByRole("region", { name: `子流程 ${name}` });
const asyncForm = (page: Page) => addMenu(page).getByRole("form", { name: "添加异步任务" });
const withSubflow = (page: Page) =>
	asyncForm(page).getByRole("checkbox", { name: "同时新建子流程" });
const subflowName = (page: Page) => addMenu(page).getByRole("textbox", { name: "子流程名称" });

test("添加异步任务时勾选「同时新建子流程」：名称为空或重名时不新建；得到两个节点和调度连线，没有来源时不连到链上；一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	await addMenu(page)
		.getByRole("option", { name: /异步任务/ })
		.click();
	await expect(withSubflow(page)).toBeFocused();
	await expect(withSubflow(page)).not.toBeChecked();
	await expect(asyncForm(page).getByText(/^新节点不连线/)).toBeVisible();
	await expect(subflowName(page)).toHaveCount(0);

	// 勾选后填写名称：规则与新建子流程入口相同。
	await page.keyboard.press("Space");
	await expect(withSubflow(page)).toBeChecked();
	await expect(subflowName(page)).toBeFocused();
	const add = asyncForm(page).getByRole("button", { name: "添加" });
	await add.click();
	await expect(asyncForm(page)).toContainText("请填写子流程名称");
	await expect(nodeCard(page, "async_1")).toHaveCount(0);
	await subflowName(page).fill("sub_entry");
	await expect(asyncForm(page)).toContainText("子流程入口节点 sub_entry 已使用名称「sub_entry」");
	await subflowName(page).press("Enter");
	await expect(nodeCard(page, "async_1")).toHaveCount(0);

	await subflowName(page).fill("压测监控");
	await subflowName(page).press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(nodeCard(page, "async_1")).toBeFocused();
	await expect(nodeCard(page, "async_1")).toHaveAttribute("aria-pressed", "true");
	await expect(nodeCard(page, "subflow_1")).toBeVisible();
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(1);
	// 没有来源：异步任务节点不接到链上。
	await expect(page.locator('[data-edge^="chain:"][data-edge*="async_1"]')).toHaveCount(0);
	await expect(region(page, "压测监控")).toContainText("async_1");

	// 子流程入口在异步任务节点下方，不压住任何节点。
	const asyncBox = await box(nodeCard(page, "async_1"));
	const subBox = await box(nodeCard(page, "subflow_1"));
	expect(subBox.y).toBeGreaterThan(asyncBox.y + asyncBox.height);
	for (const other of ["entry", "fetch", "dispatch", "ping", "sub_entry", "sub_ping", "async_1"]) {
		expect(overlap(subBox, await box(nodeCard(page, other))), other).toBe(false);
	}

	// 一步撤销：两个节点和调度连线一起回去；重做一起回来。
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "async_1")).toHaveCount(0);
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(0);
	await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
	await page.keyboard.press("Control+Shift+z");
	await expect(nodeCard(page, "async_1")).toBeVisible();
	await expect(nodeCard(page, "subflow_1")).toBeVisible();
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(1);

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const saved = (await headOf(controlPlane, id)) as unknown as {
		document: {
			nodes: { id: string; kind: string; name?: string }[];
			edges: { from: string; to: string; kind: string }[];
		};
	};
	expect(saved.document.nodes.find((n) => n.id === "subflow_1")).toMatchObject({
		kind: "subflow_entry",
		name: "压测监控",
	});
	expect(saved.document.edges).toContainEqual({
		from: "async_1",
		to: "subflow_1",
		kind: "dispatch",
	});
	expect(saved.document.edges.filter((e) => e.to === "async_1")).toEqual([]);
});

test("有来源时异步任务节点接在来源之后，子流程照样连好；不勾选时只添加异步任务节点", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	// 焦点在链尾节点上按 Tab：接在 ping 之后。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Tab");
	await page.keyboard.type("异步");
	await page.keyboard.press("Enter");
	await expect(asyncForm(page).getByText("新节点接在 ping 之后")).toBeVisible();
	await withSubflow(page).check();
	await subflowName(page).fill("夜间对账");
	await asyncForm(page).getByRole("button", { name: "添加" }).click();
	await expect(edge(page, "chain:ping->async_1")).toHaveCount(1);
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(1);
	await expect(region(page, "夜间对账")).toBeVisible();
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "async_1")).toHaveCount(0);
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);
	await expect(edge(page, "chain:ping->async_1")).toHaveCount(0);

	// 不勾选：回车直接添加，只有异步任务节点和链上的连线。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Tab");
	await page.keyboard.type("异步");
	await page.keyboard.press("Enter");
	await expect(withSubflow(page)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(edge(page, "chain:ping->async_1")).toHaveCount(1);
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);
	await expect(page.locator('[data-edge^="dispatch:async_1"]')).toHaveCount(0);

	// 刚添加过异步任务，它同时出现在「最近使用」里：这里点「内置」分组里的那一项。
	const builtinAsync = addMenu(page)
		.getByRole("group", { name: "内置" })
		.getByRole("option", { name: /异步任务/ });
	// 「返回」回到节点列表。
	await page.keyboard.press("/");
	await builtinAsync.click();
	await asyncForm(page).getByRole("button", { name: "返回" }).click();
	await expect(addMenu(page).getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	// 在表单里按 Esc 关闭：焦点回到打开菜单前的节点。
	await builtinAsync.click();
	await expect(withSubflow(page)).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(nodeCard(page, "async_1")).toBeFocused();
});

test("从调度端口拖线到空白处：填写子流程名称后新建子流程入口并连好调度连线；已有调度连线时提示原因；一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	const dispatchPort = (nodeId: string) =>
		nodeCard(page, nodeId).locator('.react-flow__handle[data-handleid="dispatch"].source');
	/** 等端口停在一个位置上再拖：刚加的节点会用一段动画移到视口中央，半路量到的起点和松开时的视口对不上。 */
	const settledBox = async (locator: Locator) => {
		let last = "";
		await expect
			.poll(async () => {
				const b = await box(locator);
				const now = `${Math.round(b.x)},${Math.round(b.y)}`;
				const same = now === last;
				last = now;
				return same;
			})
			.toBe(true);
		return box(locator);
	};
	const dragToBlank = async (nodeId: string) => {
		const from = await settledBox(dispatchPort(nodeId));
		const x = from.x + from.width / 2;
		const y = from.y + from.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 40, y + 60, { steps: 4 });
		await page.mouse.move(x + 80, y + 150, { steps: 4 });
		await page.mouse.up();
		return { x: x + 80, y: y + 150 };
	};

	// 已经调度了子流程的异步任务节点：提示原因，不打开菜单。
	await dragToBlank("dispatch");
	await expect(page.getByText("异步任务节点 dispatch 已有调度连线")).toBeVisible();
	await expect(addMenu(page)).toHaveCount(0);

	// 先在 ping 后面加一个只有异步任务的节点。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Tab");
	await page.keyboard.type("异步");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(nodeCard(page, "async_1")).toBeFocused();
	await expect(nodeCard(page, "async_1")).toContainText("1 警告");

	const drop = await dragToBlank("async_1");
	const menu = addMenu(page);
	await expect(menu).toBeVisible();
	const form = menu.getByRole("form", { name: "新建子流程" });
	await expect(form).toContainText("调度连线从 async_1 连到新的子流程入口");
	await expect(subflowName(page)).toBeFocused();
	const menuBox = await box(menu);
	expect(Math.abs(menuBox.x - drop.x)).toBeLessThan(12);
	expect(Math.abs(menuBox.y - drop.y)).toBeLessThan(12);

	// 名称为空、重名时不新建。
	await subflowName(page).press("Enter");
	await expect(form).toContainText("请填写子流程名称");
	await subflowName(page).fill("sub_entry");
	await expect(form).toContainText("子流程入口节点 sub_entry 已使用名称「sub_entry」");
	await subflowName(page).press("Enter");
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);

	// 「取消」关闭，什么都不加；焦点回到拖出连线的节点。
	await form.getByRole("button", { name: "取消" }).click();
	await expect(menu).toHaveCount(0);
	await expect(nodeCard(page, "async_1")).toBeFocused();
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);

	const placed = await dragToBlank("async_1");
	await subflowName(page).fill("压测监控");
	await subflowName(page).press("Enter");
	await expect(menu).toHaveCount(0);
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(1);
	await expect(nodeCard(page, "subflow_1")).toBeFocused();
	await expect(region(page, "压测监控")).toContainText("async_1");
	await expect(nodeCard(page, "async_1")).not.toContainText("警告");
	// 子流程入口的调度端口就在松开鼠标的位置。
	const inPort = await box(
		nodeCard(page, "subflow_1").locator('.react-flow__handle[data-handleid="dispatch"].target'),
	);
	expect(Math.abs(inPort.x + inPort.width / 2 - placed.x)).toBeLessThan(3);
	expect(Math.abs(inPort.y + inPort.height / 2 - placed.y)).toBeLessThan(3);

	// 一步撤销：子流程入口和调度连线一起回去，异步任务节点还在。
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(0);
	await expect(nodeCard(page, "async_1")).toBeVisible();
	await page.keyboard.press("Control+Shift+z");
	await expect(edge(page, "dispatch:async_1->subflow_1")).toHaveCount(1);
});

test("从调度端口拖线新建的子流程不计入添加节点菜单的「最近使用」，同一菜单里选的异步任务计入", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Tab");
	await page.keyboard.type("异步");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(nodeCard(page, "async_1")).toBeFocused();

	const from = await box(
		nodeCard(page, "async_1").locator('.react-flow__handle[data-handleid="dispatch"].source'),
	);
	const x = from.x + from.width / 2;
	const y = from.y + from.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 40, y + 60, { steps: 4 });
	await page.mouse.move(x + 80, y + 150, { steps: 4 });
	await page.mouse.up();
	await subflowName(page).fill("压测监控");
	await subflowName(page).press("Enter");
	await expect(nodeCard(page, "subflow_1")).toBeFocused();

	await page.keyboard.press("/");
	await expect(
		addMenu(page).getByRole("group", { name: "最近使用" }).getByRole("option"),
	).toHaveText([/^异步任务/]);
});
