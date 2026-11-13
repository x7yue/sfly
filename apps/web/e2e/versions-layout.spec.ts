import { createEditorScenario } from "./editor-support";
import { expect, test } from "./fixtures";
import { box } from "./support";
import { secondVersion } from "./versions-support";

// 版本历史页的版式：画布占满剩下的高度；差异里的文字不在字母中间断开。

const pane = (page: import("@playwright/test").Page, n: number) =>
	page.getByRole("region", { name: `版本 ${n}（只读）` });

test("版本画布占满页面剩下的高度：只有一个版本时下面不留空", async ({ page, controlPlane }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const id = await createEditorScenario(controlPlane);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(pane(page, 1)).toBeVisible();

	const canvas = await box(pane(page, 1));
	expect(canvas.height).toBeGreaterThanOrEqual(360);
	// 画布下沿落在页面底边距（60px）之上，下面没有一块空白。
	expect(canvas.y + canvas.height).toBeGreaterThan(800 - 70);
	expect(canvas.y + canvas.height).toBeLessThanOrEqual(800 - 50);
});

test("版本差异里的文字在空格处折行，不在单词中间断开", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	const longUrl = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
	const longVersion = {
		...secondVersion,
		nodes: secondVersion.nodes.map((n) =>
			n.id === "fetch" ? { ...n, inputs: { url: longUrl } } : n,
		),
	};
	const saved = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: longVersion }),
	});
	expect(saved.status).toBe(201);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(
		page.getByRole("region", { name: "差异" }).locator("ins", { hasText: "word0 word1" }),
	).toBeVisible();

	const wrapped = await page.evaluate(() => {
		const ins = [...document.querySelectorAll("ins")].find((el) =>
			el.textContent?.includes("word0 word1"),
		);
		const node = ins?.firstChild;
		if (!(node instanceof Text)) throw new Error("没有差异文字");
		const range = document.createRange();
		const tops = [...node.data].map((_, i) => {
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			return Math.round(range.getClientRects()[0]?.top ?? -1);
		});
		let position = 0;
		let split = 0;
		for (const word of node.data.split(" ")) {
			if (new Set(tops.slice(position, position + word.length)).size > 1) split++;
			position += word.length + 1;
		}
		return { lines: new Set(tops).size, split };
	});
	expect(wrapped.lines).toBeGreaterThan(1);
	expect(wrapped.split).toBe(0);
});
