import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// 令牌页（ADR 0029「凭据」，#491）：账号菜单里的「令牌」页（个人令牌）和项目的「项目令牌」页：
// 签发（原值只显示一次）、列表（名称、前缀、范围、状态、最后使用）、吊销。令牌真的能用、吊销后真的失效，
// 用真实控制面验证（不是只看页面）。

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };

test.use({ nickname: null, controlPlaneOptions: { initialAdmin: ADMIN } });

async function signIn(page: Page) {
	await page.goto("/login");
	await page.getByLabel("登录名").fill(ADMIN.loginName);
	await page.getByLabel("密码").fill(ADMIN.password);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page.getByRole("banner").getByRole("button", { name: /管理员/ })).toBeVisible();
}

const dialogOf = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const row = (page: Page, name: string) => page.locator(`[data-token="${name}"]`);

/** 在签发弹窗里读出令牌的原值（只显示这一次）。 */
async function issuedToken(dialog: Locator): Promise<string> {
	return dialog.getByLabel("令牌原值").inputValue();
}

test.describe("个人令牌页", () => {
	test("账号菜单进入；签发时原值只显示一次（关掉之后页面和刷新里都没有）；令牌能用；吊销后立即失效", async ({
		page,
		request,
	}) => {
		await signIn(page);
		await page
			.getByRole("banner")
			.getByRole("button", { name: /管理员/ })
			.click();
		await page.getByRole("menuitem", { name: "令牌" }).click();
		await expect(page).toHaveURL(/\/account\/tokens$/);
		await expect(page.getByRole("heading", { name: "令牌", exact: true })).toBeVisible();
		await expect(page.getByText("还没有个人令牌")).toBeVisible();

		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发个人令牌");
		// 第一次提交之前不报错；提交时校验名称，焦点放到名称上。
		await dialog.getByRole("button", { name: "签发" }).click();
		await expect(dialog.getByLabel("名称")).toBeFocused();
		await expect(dialog.getByLabel("名称")).toHaveAccessibleDescription(/填写令牌的名称/);

		await dialog.getByLabel("名称").fill("ci-bot");
		// 默认是全部范围（不勾「只要部分范围」），有效期默认 90 天。
		await expect(dialog.getByLabel("只要部分范围")).not.toBeChecked();
		await expect(dialog.getByLabel("有效期")).toHaveValue("90");
		await dialog.getByLabel("只要部分范围").check();
		await dialog.getByLabel("运行", { exact: false }).first().check();
		await dialog.getByRole("button", { name: "签发" }).click();

		const issued = dialogOf(page, "令牌「ci-bot」已签发");
		await expect(issued).toBeVisible();
		const token = await issuedToken(issued);
		expect(token).toMatch(/^sfly_pat_[A-Za-z0-9_-]{16,}$/);
		// 显示原值的时候 Esc、点遮罩都不关，也没有右上角的关闭按钮：只能点「我已保存，完成」。
		await page.keyboard.press("Escape");
		await expect(issued).toBeVisible();
		await page.mouse.click(5, 5);
		await expect(issued).toBeVisible();
		await expect(issued.getByRole("button", { name: "关闭" })).toHaveCount(0);
		await issued.getByRole("button", { name: "我已保存，完成" }).click();
		await expect(issued).toBeHidden();

		// 列表里只有前缀，没有原值：页面的 HTML 里找不到它，刷新之后也找不到。
		const tokenRow = row(page, "ci-bot");
		await expect(tokenRow).toContainText(token.slice(0, 12));
		await expect(tokenRow).toContainText("读、运行");
		await expect(tokenRow).toContainText("不限定");
		await expect(tokenRow).toContainText("从未使用");
		await expect(tokenRow).toContainText("有效");
		expect(await page.content()).not.toContain(token);
		await page.reload();
		await expect(row(page, "ci-bot")).toBeVisible();
		expect(await page.content()).not.toContain(token);

		// 令牌真的能用：请求头里带它，控制面认出是这个令牌（列表里标出「当前」）。
		const used = await request.get("/api/account/tokens", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(used.status()).toBe(200);
		const body = (await used.json()) as { tokens: { name: string; current: boolean }[] };
		expect(body.tokens).toEqual([expect.objectContaining({ name: "ci-bot", current: true })]);
		// 用过之后「最后使用」有了时间（精确到分钟）。
		await page.reload();
		await expect(row(page, "ci-bot")).not.toContainText("从未使用");

		// 吊销：确认弹窗说明后果；成功后这一行是「已吊销」，没有吊销按钮；令牌立即 401。
		await row(page, "ci-bot").getByRole("button", { name: "吊销" }).click();
		const revoke = dialogOf(page, "吊销令牌「ci-bot」？");
		await expect(revoke).toContainText("立即失效");
		await revoke.getByRole("button", { name: "吊销" }).click();
		await expect(page.getByText("已吊销令牌「ci-bot」")).toBeVisible();
		await expect(row(page, "ci-bot")).toContainText("已吊销");
		await expect(row(page, "ci-bot").getByRole("button", { name: "吊销" })).toBeHidden();
		const after = await request.get("/api/account/tokens", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(after.status()).toBe(401);
	});

	test("签发的校验：没选范围、项目标识写法不对、同名的有效令牌已经有了，都写明原因", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发个人令牌");

		await dialog.getByLabel("名称").fill("laptop");
		await dialog.getByLabel("只要部分范围").check();
		// 默认勾着「读」：取消之后一个范围都没有。
		await dialog.getByLabel("读", { exact: false }).first().uncheck();
		await dialog.getByRole("button", { name: "签发" }).click();
		await expect(dialog.getByRole("alert")).toContainText("至少选一个范围");

		await dialog.getByLabel("读", { exact: false }).first().check();
		await dialog.getByLabel("限定项目").fill("Bad_Project");
		await dialog.getByRole("button", { name: "签发" }).click();
		await expect(dialog.getByLabel("限定项目")).toBeFocused();
		await expect(dialog.getByLabel("限定项目")).toHaveAccessibleDescription(
			/小写字母、数字和连字符/,
		);

		// 限定到默认项目：列表里「限定项目」显示它。
		await dialog.getByLabel("限定项目").fill("default");
		await dialog.getByLabel("有效期").selectOption("never");
		await dialog.getByRole("button", { name: "签发" }).click();
		await dialogOf(page, "令牌「laptop」已签发")
			.getByRole("button", { name: "我已保存，完成" })
			.click();
		await expect(row(page, "laptop")).toContainText("default");
		await expect(row(page, "laptop")).toContainText("不过期");

		// 同名的有效令牌已经有了：错误写在弹窗里，不发通知。
		await page.getByRole("button", { name: "签发令牌" }).click();
		const again = dialogOf(page, "签发个人令牌");
		await again.getByLabel("名称").fill("laptop");
		await again.getByRole("button", { name: "签发" }).click();
		await expect(again.getByRole("alert")).toContainText("已经有一个同名的有效令牌");
		// 吊销旧的之后同名的就能签了。
		await again.getByRole("button", { name: "取消" }).click();
		await row(page, "laptop").getByRole("button", { name: "吊销" }).click();
		await dialogOf(page, "吊销令牌「laptop」？").getByRole("button", { name: "吊销" }).click();
		await expect(row(page, "laptop")).toContainText("已吊销");
		await page.getByRole("button", { name: "签发令牌" }).click();
		await dialogOf(page, "签发个人令牌").getByLabel("名称").fill("laptop");
		await dialogOf(page, "签发个人令牌").getByRole("button", { name: "签发" }).click();
		await expect(dialogOf(page, "令牌「laptop」已签发")).toBeVisible();
	});

	// 控制面的时钟要走过 31 天，默认的登录闲置时限（12 小时）会先到，页面按「登录失效」回到登录页（#490），
	// 看不到令牌列表了：这一条把登录闲置时限放长，只留令牌自己的有效期。
	test.describe("时钟走过令牌的有效期", () => {
		test.use({
			controlPlaneOptions: { initialAdmin: ADMIN, loginIdleMs: 365 * 24 * 3600 * 1000 },
		});

		test("过期的令牌：到了过期时间，列表里变成「已过期」，不再有吊销按钮，令牌 401", async ({
			page,
			request,
			clock,
		}) => {
			await signIn(page);
			await page.goto("/account/tokens");
			await page.getByRole("button", { name: "签发令牌" }).click();
			const dialog = dialogOf(page, "签发个人令牌");
			await dialog.getByLabel("名称").fill("short-lived");
			await dialog.getByLabel("有效期").selectOption("30");
			await dialog.getByRole("button", { name: "签发" }).click();
			const issued = dialogOf(page, "令牌「short-lived」已签发");
			const token = await issuedToken(issued);
			await issued.getByRole("button", { name: "我已保存，完成" }).click();
			await expect(row(page, "short-lived")).toContainText("有效");

			// 控制面的时钟走到 31 天之后：页面按控制面的时间算，到点就是「已过期」。
			clock.advance(31 * 24 * 3600 * 1000);
			await expect(row(page, "short-lived")).toContainText("已过期", { timeout: 15_000 });
			await expect(row(page, "short-lived").getByRole("button", { name: "吊销" })).toBeHidden();
			const expired = await request.get("/api/account/tokens", {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(expired.status()).toBe(401);
		});
	});
});

test.describe("项目令牌页", () => {
	test("按路径里的项目显示：签发的范围里没有「管理」；列表、吊销；个人令牌页指向它", async ({
		page,
		request,
	}) => {
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("link", { name: "项目令牌" }).click();
		await expect(page).toHaveURL(/\/projects\/default\/tokens$/);
		await expect(page.getByRole("heading", { name: "项目令牌", exact: true })).toBeVisible();
		await expect(page.getByText("这个项目还没有项目令牌")).toBeVisible();

		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发项目令牌");
		// 项目令牌的范围必选，不能带「管理」：选项里没有它，并写明原因。
		await expect(dialog.getByLabel("管理", { exact: false })).toHaveCount(0);
		await expect(dialog).toContainText("项目令牌不能带「管理」范围");
		await expect(dialog.getByLabel("限定项目")).toHaveCount(0);

		await dialog.getByLabel("名称").fill("nightly");
		await dialog.getByLabel("读", { exact: false }).first().uncheck();
		await dialog.getByRole("button", { name: "签发" }).click();
		await expect(dialog.getByRole("alert")).toContainText("至少选一个范围");
		await dialog.getByLabel("读", { exact: false }).first().check();
		await dialog.getByLabel("运行", { exact: false }).first().check();
		await dialog.getByRole("button", { name: "签发" }).click();

		const issued = dialogOf(page, "令牌「nightly」已签发");
		const token = await issuedToken(issued);
		expect(token).toMatch(/^sfly_prj_[A-Za-z0-9_-]{16,}$/);
		await issued.getByRole("button", { name: "我已保存，完成" }).click();
		// 弹窗关掉（退出动画结束、DOM 里没有了）之后，页面里才不该再有原值。
		await expect(issued).toBeHidden();
		await expect(row(page, "nightly")).toContainText("读、运行");
		await expect(row(page, "nightly")).toContainText("有效");
		// 项目令牌属于项目、不随签发人失效，但记着是谁签发的：「签发人」列写着登录的这个人。
		await expect(row(page, "nightly").locator('[data-slot="token-issuer"]')).toHaveText("管理员");
		expect(await page.content()).not.toContain(token);

		// 项目令牌属于项目，不是某个人：个人令牌页里没有它。
		await page.goto("/account/tokens");
		await expect(page.getByText("还没有个人令牌")).toBeVisible();

		await page.goto("/projects/default/tokens");
		await row(page, "nightly").getByRole("button", { name: "吊销" }).click();
		await dialogOf(page, "吊销令牌「nightly」？").getByRole("button", { name: "吊销" }).click();
		await expect(row(page, "nightly")).toContainText("已吊销");
		const gone = await request.get("/api/projects/default/tokens", {
			headers: { authorization: `Bearer ${token}` },
		});
		// 吊销了就是 401；（没吊销时项目令牌也没有「管理」范围，读不了令牌列表：403）。
		expect(gone.status()).toBe(401);
	});

	test("没有「管理」范围（或项目不存在）时：照实显示控制面的说明，不装作没有令牌", async ({
		page,
	}) => {
		await signIn(page);
		await page.route("**/api/projects/default/tokens", (route) =>
			route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({
					error: {
						code: "forbidden",
						message: "这个操作需要「管理」范围，你在这个项目里没有",
					},
				}),
			}),
		);
		await page.goto("/projects/default/tokens");
		await expect(page.getByText("无法加载令牌")).toBeVisible();
		await expect(page.getByText("这个操作需要「管理」范围")).toBeVisible();
		await expect(page.getByText("这个项目还没有项目令牌")).toBeHidden();
	});
});
