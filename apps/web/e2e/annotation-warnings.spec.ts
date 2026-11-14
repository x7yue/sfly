import {
	annotated,
	annotationBand,
	annotationFrame,
	annotationTitleBox,
	frames,
	memberList,
	savedAnnotations,
	type TestAnnotation,
} from "./annotation-support";
import { editorDocument, headOf, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, scenarioUsing } from "./support";

// 注释框的警告（#316）：引用不存在的成员、没有成员、成员写了两次。只警告：校验面板列出、点「前往」选中注释框；
// 不阻断触发；画框时跳过不存在的成员；打开、保存时不自动清理，什么都不改就不算有修改。

/** 这些写法只会来自命令行 push（画布不能建出它们）。 */
const WRITTEN_BY_CLI: TestAnnotation[] = [
	{
		id: "annotation_1",
		title: "主链后半段",
		nodes: ["dispatch", "ping", "http_request_9"],
		subflows: ["nowhere"],
	},
	{ id: "annotation_2", title: "还没想好", nodes: [], subflows: [] },
	{ id: "annotation_3", title: "写重复了", nodes: ["fetch", "fetch"], subflows: [] },
	{ id: "annotation_4", title: "全是错的", nodes: ["gone"], subflows: [] },
];

const MESSAGES = {
	annotation_1: [
		"注释框「主链后半段」（annotation_1）引用了不存在的节点 http_request_9",
		"注释框「主链后半段」（annotation_1）引用了不存在的子流程 nowhere",
	],
	annotation_2: ["注释框「还没想好」（annotation_2）没有成员"],
	annotation_3: ["注释框「写重复了」（annotation_3）把节点 fetch 写了 2 次"],
	annotation_4: ["注释框「全是错的」（annotation_4）引用了不存在的节点 gone"],
};

async function scenarioWith(cp: Parameters<typeof publishPackage>[0], list = WRITTEN_BY_CLI) {
	await publishPackage(cp);
	return createScenario(cp, "日终数据处理", annotated(list, editorDocument));
}

test("校验面板列出注释框的警告，写出注释框和成员；点「前往」选中这个注释框，没有成员、画不出来的也能选中", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane);
	await openEditor(page, id);

	await page.getByRole("button", { name: "5 条警告" }).click();
	const warning = (text: string) => inspector(page).getByRole("listitem").filter({ hasText: text });
	for (const messages of Object.values(MESSAGES)) {
		for (const message of messages) await expect(warning(message)).toBeVisible();
	}
	// 节点卡片上没有警告标记：问题出在注释框上。
	await expect(nodeCard(page, "ping")).not.toContainText("警告");

	await warning(MESSAGES.annotation_1[0] as string)
		.getByRole("button", { name: "前往" })
		.click();
	await expect(inspector(page).getByRole("heading", { name: "主链后半段" })).toBeVisible();
	await expect(annotationBand(page, "主链后半段")).toHaveAttribute("aria-pressed", "true");
	await expect(memberList(page).getByRole("listitem")).toHaveText([
		/dispatch/,
		/ping/,
		/http_request_9/,
		/子流程 nowhere/,
	]);

	// 一个有效成员都没有的注释框不画，仍然能从警告里选中，在检查器里处理。
	await page.getByRole("button", { name: "5 条警告" }).click();
	await warning(MESSAGES.annotation_2[0] as string)
		.getByRole("button", { name: "前往" })
		.click();
	await expect(inspector(page).getByRole("heading", { name: "还没想好" })).toBeVisible();
	await expect(annotationTitleBox(page)).toHaveValue("还没想好");
	await expect(annotationFrame(page, "annotation_2")).toHaveCount(0);
});

test("画框时跳过不存在的成员；一个有效成员都没有的注释框不画", async ({ page, controlPlane }) => {
	const id = await scenarioWith(controlPlane);
	await openEditor(page, id);

	const frame = await box(annotationFrame(page, "annotation_1"));
	expect(frames(frame, await box(nodeCard(page, "dispatch")))).toBe(true);
	expect(frames(frame, await box(nodeCard(page, "ping")))).toBe(true);
	// 框只住有效成员：不会被不存在的成员撑大，也没有压住主链前半段。
	expect(frames(frame, await box(nodeCard(page, "fetch")))).toBe(false);
	await expect(annotationFrame(page, "annotation_3")).toBeVisible();
	await expect(annotationFrame(page, "annotation_2")).toHaveCount(0);
	await expect(annotationFrame(page, "annotation_4")).toHaveCount(0);
});

test("打开这样的场景什么都不改就不算有修改：保存提示没有未保存的修改，不产生新版本；改了别处再保存，写错的成员原样保留", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane);
	await openEditor(page, id);
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("没有未保存的修改")).toBeVisible();
	expect((await headOf(controlPlane, id)).number).toBe(1);
	expect(await savedAnnotations(controlPlane, id)).toEqual(WRITTEN_BY_CLI);

	// 只改一个注释框的标题再保存：其余写错的注释框和成员不会被顺手清理。
	await annotationBand(page, "写重复了").click();
	await annotationTitleBox(page).fill("写重复了（已确认）");
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText("5 条警告，不影响触发运行")).toBeVisible();
	const expected = WRITTEN_BY_CLI.map((a) =>
		a.id === "annotation_3" ? { ...a, title: "写重复了（已确认）" } : a,
	);
	expect(await savedAnnotations(controlPlane, id)).toEqual(expected);
});

test("只有注释框的警告时，触发运行前检查照样通过，可以触发", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(
		controlPlane,
		"巡检",
		annotated(
			[{ id: "annotation_1", title: "写错了", nodes: ["ping", "gone"], subflows: [] }],
			scenarioUsing("agent-a"),
		),
	);

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toContainText(
		"结构与引用检查通过",
	);
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeEnabled();
});
