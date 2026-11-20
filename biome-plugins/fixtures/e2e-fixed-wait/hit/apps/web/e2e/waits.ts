export async function settle(page: Page) {
	// @hit
	await page.waitForTimeout(500);
	// @hit
	await page.waitForTimeout(timeoutMs);
}
