export async function editText(page: Page) {
	// 写成 ControlOrMeta：不拦。
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.press("ControlOrMeta+a");
	// 应用自己的快捷键在两个平台都认 Control：不拦。
	await page.keyboard.press("Control+k");
	await page.keyboard.press("Control+s");
}
