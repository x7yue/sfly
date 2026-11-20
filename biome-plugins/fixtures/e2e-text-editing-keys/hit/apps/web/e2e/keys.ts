export async function editText(page: Page) {
	// @hit
	await page.keyboard.press("Control+Home");
	// @hit
	await page.keyboard.press("Control+End");
	// @hit
	await page.keyboard.press("Control+a");
	// @hit
	await page.keyboard.press("Control+Shift+Home");
	// @hit
	await page.keyboard.press("Control+Shift+End");
}
