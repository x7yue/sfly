import type { Page } from "@playwright/test";
import { createEditorScenario, headOf, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import {
	addLegacyStickyNotes,
	LEGACY_STICKY_NOTES,
	LEGACY_STICKY_TEXTS,
} from "./legacy-sticky-support";

// 便签（sticky_notes，ADR 0026）已移除（ADR 0028）：升级前保存的每个版本都带着它，也可能有内容。
// 读取不报错、不显示；保存新版本时不再带上；从浏览器的本地草稿恢复时也先丢掉它。

const NAME = "拉取快照";

const unsaved = (page: Page) => page.getByText("有未保存的修改");
const titleOf = (page: Page, id: string) =>
	nodeCard(page, id).locator('[data-slot="base-node-title"]');

/** 画布和页面上都没有便签：没有便签元素，便签里写的字也不在页面上。 */
async function expectNoStickyNotes(page: Page) {
	await expect(page.locator("[data-sticky-note]")).toHaveCount(0);
	for (const text of LEGACY_STICKY_TEXTS) await expect(page.getByText(text)).toHaveCount(0);
}

/** 双击标题给 fetch 节点起显示名称。 */
async function renameFetch(page: Page) {
	await titleOf(page, "fetch").dblclick();
	const input = nodeCard(page, "fetch").getByRole("textbox", { name: "显示名称" });
	await input.fill(NAME);
	await input.press("Enter");
	await expect(unsaved(page)).toBeVisible();
}

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

/** 控制面上最新版本：版本号、fetch 节点的显示名称，以及文档里有没有 `sticky_notes`。 */
async function savedHead(cp: Parameters<typeof headOf>[0], id: string) {
	const { number, document } = await headOf(cp, id);
	const fetch = document.nodes.find((n) => n.id === "fetch") as { display_name?: string };
	return { number, name: fetch.display_name, hasSticky: "sticky_notes" in document };
}

test("最新版本带着便签（升级前保存的）：打开不报错、画布上没有便签；只改个节点名就能保存，新版本里没有 sticky_notes", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await addLegacyStickyNotes(controlPlane, id);

	await openEditor(page, id);
	await expectNoStickyNotes(page);
	await expect(unsaved(page)).toHaveCount(0);

	await renameFetch(page);
	await save(page, 2);
	expect(await savedHead(controlPlane, id)).toEqual({ number: 2, name: NAME, hasSticky: false });

	// 刷新后还是没有便签，也没有未保存的修改。
	await page.reload();
	await expect(nodeCard(page, "sub_ping")).toBeVisible();
	await expectNoStickyNotes(page);
	await expect(unsaved(page)).toHaveCount(0);
});

test("版本历史里对比带着便签的旧版本：画布上没有便签，差异里没有「便签」一组，只有这次改的节点", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await addLegacyStickyNotes(controlPlane, id);
	await openEditor(page, id);
	await renameFetch(page);
	await save(page, 2);

	await page.goto(`/orchestrations/${id}/versions?a=1&b=2`);
	const diff = page.getByRole("region", { name: "差异" });
	await expect(diff.getByRole("region", { name: "节点" })).toContainText(NAME);
	await expect(diff.getByRole("region", { name: "便签" })).toHaveCount(0);
	await expect(diff.getByRole("region", { name: "布局" })).toHaveCount(0);
	await expectNoStickyNotes(page);
});

test("本地草稿是升级前存下的（带着便签）：恢复后画布上没有便签，草稿里的修改还在，保存成功且新版本里没有 sticky_notes", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	const { number, document } = await headOf(controlPlane, id);
	const withStickyNotes = (doc: object) => ({ ...doc, sticky_notes: LEGACY_STICKY_NOTES });
	const edited = {
		...document,
		nodes: document.nodes.map((n) => (n.id === "fetch" ? { ...n, display_name: NAME } : n)),
	};
	await page.addInitScript(
		([key, draft]) => window.localStorage.setItem(key, JSON.stringify(draft)),
		[
			`sfly.draft.${id}`,
			{
				base_version: number,
				base_author: "tester",
				base_document: withStickyNotes(document),
				document: withStickyNotes(edited),
				updated_at: "2026-01-01T00:00:00.000Z",
			},
		] as const,
	);

	await openEditor(page, id);
	await expectNoStickyNotes(page);
	// 草稿里的修改（改了节点名）恢复了，它是唯一的未保存修改。
	await expect(unsaved(page)).toBeVisible();
	await expect(titleOf(page, "fetch")).toHaveText(NAME);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();

	await save(page, 2);
	expect(await savedHead(controlPlane, id)).toEqual({ number: 2, name: NAME, hasSticky: false });
});
