import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectNoUnsafeText, failRequests, HOSTILE, writtenOutOn } from "./untrusted-support";

// 控制台显示别人写的文字（#699）：接口的错误信息里常嵌着 Agent 报的原文，弹窗里的错误（`FormAlert`，读屏立刻读）和通知（`notify`）
// 里的字符串一律经组件显示。要登录，所以和别的用例分开一个文件。

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };

test.use({ loginAs: null, controlPlaneOptions: { initialAdmin: ADMIN } });

async function signIn(page: Page) {
	await page.goto("/login");
	await page.getByLabel("登录名").fill(ADMIN.loginName);
	await page.getByLabel("密码").fill(ADMIN.password);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page.getByRole("banner").getByRole("button", { name: /管理员/ })).toBeVisible();
}

const hostileText = (label: string) => `${label}${HOSTILE.bidi}gpj.exe ${HOSTILE.zeroWidth}隐藏`;

test("弹窗：签发令牌失败，弹窗里的错误（role=alert）里的有害字符写出来", async ({ page }) => {
	await signIn(page);
	await page.goto("/account/tokens");
	await failRequests(page, "**/api/account/tokens", "POST", hostileText("签发失败"));
	await page.getByRole("button", { name: "签发令牌" }).click();
	const dialog = page.getByRole("dialog", { name: "签发个人令牌" });
	await dialog.getByLabel("名称").fill("ci-bot");
	await dialog.getByRole("button", { name: "签发" }).click();
	const alert = dialog.getByRole("alert");
	await expect(alert).toContainText("签发失败");
	await expectNoUnsafeText(page, dialog, "签发令牌的弹窗：");
	expect(await writtenOutOn(page, alert)).toContain("U+202E");
	expect(await writtenOutOn(page, alert)).toContain("U+200B");
});

test("通知：登出失败，通知里的错误信息里的有害字符写出来", async ({ page }) => {
	await signIn(page);
	await failRequests(page, "**/api/auth/logout", "POST", hostileText("登出失败"));
	await page
		.getByRole("banner")
		.getByRole("button", { name: /管理员/ })
		.click();
	await page.getByRole("menuitem", { name: "登出" }).click();
	const toast = page.locator("[data-sonner-toast]").filter({ hasText: "登出失败" });
	await expect(toast).toBeVisible();
	await expectNoUnsafeText(page, toast, "登出失败的通知：");
	expect(await writtenOutOn(page, toast)).toContain("U+202E");
});
