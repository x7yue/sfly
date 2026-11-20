export async function settle(page: Page) {
	// 在等待条件里断言：不拦。
	await expect(page.getByText("完成")).toBeVisible();
	await page.waitForSelector("[data-ready]");
	// 文档里写明的例外：带原因的 biome-ignore 放行。
	// biome-ignore lint/plugin/e2e-fixed-wait: 断言的是没有发生的事：过了防抖时间之后旧关键字没有被写回地址
	await page.waitForTimeout(300);
}
