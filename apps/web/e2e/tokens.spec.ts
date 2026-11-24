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
		// 默认是全部范围（「范围的选法」停在「全部范围」，下面没有勾选项），有效期默认 90 天。
		const scopeChoice = dialog.getByRole("group", { name: "范围的选法" });
		await expect(scopeChoice.getByRole("button", { name: "全部范围" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(dialog.getByRole("checkbox")).toHaveCount(0);
		await expect(dialog.getByLabel("有效期")).toHaveValue("90");
		await scopeChoice.getByRole("button", { name: "只选一部分" }).click();
		await expect(dialog.getByRole("checkbox", { name: /^读/ })).toBeChecked();
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
		// 点「完成」关掉之后焦点回到「签发令牌」（签发前列表是空的，按钮在空状态里；签发之后在页头，同一时刻只有一个）。
		await expect(page.getByRole("button", { name: "签发令牌" })).toBeFocused();

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

	test("刚签发的令牌：原值比只读框宽，也能整个选中、用键盘和「复制」按钮复制出完整的原值", async ({
		page,
	}) => {
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发个人令牌");
		await dialog.getByLabel("名称").fill("copy-check");
		await dialog.getByRole("button", { name: "签发", exact: true }).click();
		const issued = dialogOf(page, "令牌「copy-check」已签发");
		const box = issued.getByLabel("令牌原值");
		const token = await issuedToken(issued);
		// 基线里原值是遮住的，这里量：原值比只读框宽（框里放不下，只显示一部分）。
		const sizes = await box.evaluate((el: HTMLInputElement) => ({
			scroll: el.scrollWidth,
			client: el.clientWidth,
		}));
		expect(sizes.scroll, "原值比只读框宽").toBeGreaterThan(sizes.client);
		// 弹出来时焦点就在框里、原值整个被选中：选区从头到尾。
		await expect(box).toBeFocused();
		const selection = await box.evaluate((el: HTMLInputElement) => [
			el.selectionStart,
			el.selectionEnd,
			el.value.length,
		]);
		expect(selection).toEqual([0, token.length, token.length]);
		// 键盘复制拿到完整的原值。
		await page.keyboard.press("ControlOrMeta+c");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
		// 「复制」按钮拿到的也是完整的原值。
		await page.evaluate(() => navigator.clipboard.writeText(""));
		await issued.getByRole("button", { name: "复制" }).click();
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(token);
		await issued.getByRole("button", { name: "我已保存，完成" }).click();
	});

	test("签发的校验：没选范围、项目标识写法不对、同名的有效令牌已经有了，都写明原因", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发个人令牌");

		const issue = dialog.getByRole("button", { name: "签发", exact: true });
		await dialog.getByLabel("名称").fill("laptop");
		await dialog.getByRole("button", { name: "只选一部分" }).click();
		// 默认勾着「读」：取消之后一个范围都没有。
		await dialog.getByLabel("读", { exact: false }).first().uncheck();
		await issue.click();
		await expect(dialog.getByRole("alert")).toContainText("至少选一个范围");
		// 标着问题的时候「签发」不可用（看起来不该能点），改好之后恢复；焦点在第一个勾选框上，不落到页面上。
		await expect(issue).toBeDisabled();
		await expect(dialog.getByRole("checkbox").first()).toBeFocused();

		await dialog.getByLabel("读", { exact: false }).first().check();
		await expect(issue).toBeEnabled();
		await dialog.getByLabel("限定项目").fill("Bad_Project");
		await expect(dialog.getByLabel("限定项目")).toHaveAccessibleDescription(
			/小写字母、数字和连字符/,
		);
		await expect(issue).toBeDisabled();

		// 限定到默认项目：列表里「限定项目」显示它。
		await dialog.getByLabel("限定项目").fill("default");
		await expect(issue).toBeEnabled();
		await dialog.getByLabel("有效期").selectOption("never");
		await issue.click();
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
	test("「只选一部分」一个都不勾：在「签发」上按 Enter，焦点到第一个勾选框（不落到页面上），用键盘勾上之后「签发」恢复", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发个人令牌");
		const issue = dialog.getByRole("button", { name: "签发", exact: true });
		await dialog.getByLabel("名称").fill("keyboard-user");
		await dialog.getByRole("button", { name: "只选一部分" }).click();
		await dialog.getByLabel("读", { exact: false }).first().uncheck();
		// 键盘：焦点在「签发」上按 Enter。提交之后「签发」不可用，焦点不能留在它上面。
		await issue.focus();
		await page.keyboard.press("Enter");
		await expect(dialog.getByRole("alert")).toContainText("至少选一个范围");
		await expect(issue).toBeDisabled();
		const first = dialog.getByRole("checkbox").first();
		await expect(first).toBeFocused();
		// 空格勾上它：「签发」恢复，焦点还在勾选框上。
		await page.keyboard.press("Space");
		await expect(first).toBeChecked();
		await expect(issue).toBeEnabled();
		await expect(first).toBeFocused();
	});

	test("Esc 关掉签发弹窗之后，焦点回到打开它的「签发令牌」按钮", async ({ page }) => {
		await signIn(page);
		await page.goto("/account/tokens");
		await page.getByRole("button", { name: "签发令牌" }).click();
		await expect(dialogOf(page, "签发个人令牌")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialogOf(page, "签发个人令牌")).toBeHidden();
		await expect(page.getByRole("button", { name: "签发令牌" })).toBeFocused();
	});

	test("1280×800：有六个范围都勾上的令牌、名称很长时，名称列不被挤没（不窄于 11rem），表格不超出面板，范围折成两行", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await signIn(page);
		const longName = "夜间批量回归和发布前检查用的自动化脚本-第二套环境";
		await page.evaluate(async (name) => {
			await fetch("/api/account/tokens", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name, project: "default", expires_in_days: 90 }),
			});
		}, longName);
		await page.goto("/account/tokens");
		const tokenRow = row(page, longName);
		await expect(tokenRow).toBeVisible();
		await expect(tokenRow).toContainText("读、运行、编辑、会话构建、发布、管理");
		const measured = await page.evaluate((name) => {
			const table = document.querySelector("table") as HTMLElement;
			const head = [...table.querySelectorAll("th")].find((th) => th.textContent === "名称");
			const scopes = document.querySelector(`[data-token="${name}"] td:nth-child(3) span`);
			const fence = table.parentElement as HTMLElement;
			return {
				name: Math.round((head as HTMLElement).getBoundingClientRect().width),
				scopeLines: Math.round(
					(scopes as HTMLElement).getBoundingClientRect().height /
						Number.parseFloat(getComputedStyle(scopes as HTMLElement).lineHeight),
				),
				overflow: Math.round(table.getBoundingClientRect().width - fence.clientWidth),
			};
		}, longName);
		// 名称列不窄于 11rem（176px，已含内边距）；表格没有比面板宽（1280 宽下其他列加起来要给名称留够这 176px）；六个范围写不下一行（7rem 的上限），折成两行。
		expect(measured.name, JSON.stringify(measured)).toBeGreaterThanOrEqual(176);
		expect(measured.overflow, JSON.stringify(measured)).toBeLessThanOrEqual(0);
		expect(measured.scopeLines, JSON.stringify(measured)).toBe(2);
	});

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
		// 项目令牌页写明项目名，并能回到个人令牌页。
		await expect(page.getByRole("link", { name: "个人令牌", exact: true })).toBeVisible();

		await page.getByRole("button", { name: "签发令牌" }).click();
		const dialog = dialogOf(page, "签发项目令牌");
		// 项目令牌的范围必选，不能带「管理」：选项里没有它，并写明原因。
		await expect(dialog.getByLabel("管理", { exact: false })).toHaveCount(0);
		await expect(dialog).toContainText("项目令牌不能带「管理」范围");
		await expect(dialog.getByLabel("限定项目")).toHaveCount(0);

		await dialog.getByLabel("名称").fill("nightly");
		await dialog.getByLabel("读", { exact: false }).first().uncheck();
		await dialog.getByRole("button", { name: "签发", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("至少选一个范围");
		await expect(dialog.getByRole("button", { name: "签发", exact: true })).toBeDisabled();
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
