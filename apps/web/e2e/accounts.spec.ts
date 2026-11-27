import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// pg 是控制面的依赖（apps/web 没有它）：和 legacy-sticky-support.ts 一样从控制面的包里取。
const { Client } = createRequire(new URL("../../server/package.json", import.meta.url))("pg") as {
	Client: new (options: {
		connectionString: string;
	}) => {
		connect(): Promise<void>;
		query(sql: string): Promise<{ rows: unknown[] }>;
		end(): Promise<void>;
	};
};

// 本地账号与登录（ADR 0029，#490）：初始化页建第一个管理员、登录页、账号菜单（修改密码、登出）、写操作的身份来自登录。
// #494 起不登录用不了控制台：没有登录打开别的页面都换到登录页，登录之后回到原来的页面。

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
const NEW_PASSWORD = "brand-new-password-1";

/** 从没有登录开始：浏览器里没有登录 Cookie。 */
test.use({ loginAs: null });

async function login(page: import("@playwright/test").Page, password = ADMIN.password) {
	await page.getByLabel("登录名").fill(ADMIN.loginName);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录" }).click();
}

const accountMenu = (page: import("@playwright/test").Page) =>
	page.getByRole("banner").getByRole("button", { name: /管理员/ });

test.describe("初始化页（没有任何用户）", () => {
	test("用初始化码创建第一个管理员并登录：回到首页，顶栏是账号菜单，不弹昵称弹窗；初始化码用过即失效", async ({
		page,
		controlPlane,
	}) => {
		const code = (await readFile(join(controlPlane.dataDir, "setup-code"), "utf8")).trim();
		await page.goto("/login");
		// 登录页知道还没有用户，指向初始化页。
		await page.getByRole("link", { name: "用初始化码创建第一个管理员" }).click();
		await expect(page).toHaveURL(/\/setup$/);
		await expect(page.getByRole("heading", { name: "创建第一个管理员" })).toBeVisible();

		// 第一次提交之前不报错；提交时校验，焦点放到第一个出错的字段。
		await page.getByRole("button", { name: "创建并登录" }).click();
		await expect(page.getByLabel("初始化码")).toBeFocused();
		await expect(page.getByLabel("初始化码")).toHaveAccessibleDescription("填写初始化码");
		// 「再输入一遍」为空时和别的必填项一样给出提示。
		await expect(page.getByLabel("再输入一遍密码")).toHaveAccessibleDescription("再输入一遍密码");
		// 正常配置下（没有配公开地址、Host 一致）没有「请用 … 打开」的提示。
		await expect(page.locator('[data-slot="origin-notice"]')).toBeHidden();

		await page.getByLabel("初始化码").fill("AAAA-BBBB-CCCC-DDDD-EEEE");
		await page.getByLabel("登录名").fill("Root-1");
		await page.getByLabel("显示名").fill(ADMIN.displayName);
		await page.getByLabel(/^密码/).fill(ADMIN.password);
		await page.getByLabel("再输入一遍密码").fill("不一样的密码");
		await page.getByRole("button", { name: "创建并登录" }).click();
		await expect(page.getByLabel("登录名")).toHaveAccessibleDescription(/小写字母、数字和下划线/);
		await page.getByLabel("登录名").fill(ADMIN.loginName);
		await page.getByRole("button", { name: "创建并登录" }).click();
		await expect(page.getByLabel("再输入一遍密码")).toHaveAccessibleDescription(
			"两次输入的密码不一致",
		);
		await page.getByLabel("再输入一遍密码").fill(ADMIN.password);

		// 码不对：服务端的错误写在表单里，不发通知。
		await page.getByRole("button", { name: "创建并登录" }).click();
		await expect(page.getByRole("alert")).toContainText("初始化码不对");
		await expect(page).toHaveURL(/\/setup$/);

		await page.getByLabel("初始化码").fill(code);
		await page.getByRole("button", { name: "创建并登录" }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(accountMenu(page)).toBeVisible();
		await expect(page.getByRole("dialog", { name: "欢迎使用 sfly" })).toBeHidden();

		// 用过的码失效：初始化页只剩一句指路。
		await page.goto("/setup");
		await expect(page.getByRole("heading", { name: "已经初始化过了" })).toBeVisible();
		await expect(page.getByRole("link", { name: "去登录" })).toBeVisible();
	});
});

test.describe("登录与账号菜单", () => {
	test.use({ controlPlaneOptions: { initialAdmin: ADMIN } });

	test("登录页：字段校验；登录名或密码不对写在表单里；登录后回到首页，刷新仍是登录的，昵称弹窗不出现", async ({
		page,
	}) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		// 登录页上没有任何弹窗。
		await expect(page.getByRole("dialog")).toBeHidden();
		// 已经有用户：登录页不再指向初始化页。
		await expect(page.getByRole("link", { name: "用初始化码创建第一个管理员" })).toBeHidden();

		await page.getByRole("button", { name: "登录" }).click();
		await expect(page.getByLabel("登录名")).toBeFocused();
		await expect(page.getByLabel("登录名")).toHaveAccessibleDescription("填写登录名");

		await login(page, "不对的密码");
		await expect(page.getByRole("alert")).toContainText("登录名或密码不对");
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByLabel("密码")).toHaveValue("");

		await page.getByLabel("密码").fill(ADMIN.password);
		await page.getByRole("button", { name: "登录" }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(accountMenu(page)).toBeVisible();
		await expect(page.getByRole("dialog", { name: "欢迎使用 sfly" })).toBeHidden();

		await page.reload();
		await expect(accountMenu(page)).toBeVisible();
		await expect(page.getByRole("dialog", { name: "欢迎使用 sfly" })).toBeHidden();
	});

	test("登录后回到 redirect 指的本站路径；别的站点的地址一律回首页", async ({ page }) => {
		await page.goto("/login?redirect=%2Fagents");
		await login(page);
		await expect(page).toHaveURL(/\/agents$/);

		await page.getByRole("button", { name: /管理员/ }).click();
		await page.getByRole("menuitem", { name: "登出" }).click();
		await expect(page).toHaveURL(/\/login$/);

		await page.goto("/login?redirect=%2F%2Fevil.example%2Fx");
		await login(page);
		await expect(page).toHaveURL(/\/$/);
	});

	test("账号菜单：显示名、登录名、平台管理员标记；登出回到登录页，之后打开首页又被带回登录页", async ({
		page,
	}) => {
		await page.goto("/login");
		await login(page);
		await accountMenu(page).click();
		const menu = page.getByRole("menu");
		await expect(menu).toContainText("管理员");
		await expect(menu).toContainText("root");
		await expect(menu).toContainText("平台管理员");

		await menu.getByRole("menuitem", { name: "登出" }).click();
		await expect(page).toHaveURL(/\/login$/);
		// 登出之后：没有登录，打开首页被带回登录页（redirect 指回首页）。
		await page.goto("/");
		await expect(page).toHaveURL(/\/login\?/);
		expect(new URL(page.url()).searchParams.get("redirect")).toBe("/");
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		await expect(accountMenu(page)).toBeHidden();
	});

	test("修改密码：旧密码不对写在弹窗里；改成功后新密码能登录、旧密码不行", async ({ page }) => {
		await page.goto("/login");
		await login(page);
		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "修改密码…" }).click();
		const dialog = page.getByRole("dialog", { name: "修改密码" });

		await dialog.getByRole("button", { name: "修改密码" }).click();
		await expect(dialog.getByLabel("旧密码")).toBeFocused();
		await expect(dialog.getByLabel("再输入一遍新密码")).toHaveAccessibleDescription(
			"再输入一遍新密码",
		);
		await dialog.getByLabel("旧密码").fill("不对的旧密码");
		await dialog.getByLabel(/^新密码/).fill(NEW_PASSWORD);
		await dialog.getByLabel("再输入一遍新密码").fill("不一样");
		await dialog.getByRole("button", { name: "修改密码" }).click();
		await expect(dialog.getByLabel("再输入一遍新密码")).toHaveAccessibleDescription(
			"两次输入的新密码不一致",
		);
		await dialog.getByLabel("再输入一遍新密码").fill(NEW_PASSWORD);
		await dialog.getByRole("button", { name: "修改密码" }).click();
		await expect(dialog.getByRole("alert")).toContainText("旧密码不对");

		await dialog.getByLabel("旧密码").fill(ADMIN.password);
		await dialog.getByRole("button", { name: "修改密码" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByText("密码已修改")).toBeVisible();
		// 当前登录保留。
		await page.reload();
		await expect(accountMenu(page)).toBeVisible();

		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "登出" }).click();
		await login(page, ADMIN.password);
		await expect(page.getByRole("alert")).toContainText("登录名或密码不对");
		await page.getByLabel("密码").fill(NEW_PASSWORD);
		await page.getByRole("button", { name: "登录" }).click();
		await expect(page).toHaveURL(/\/$/);
	});

	test("登录之后触发运行：页面上的触发人是登录的显示名，库里记下用户 ID（身份来自登录，不是昵称）", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await connectAgent({ name: "agent-a" });
		await publishPackage(controlPlane);
		await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));

		await page.goto("/login");
		await login(page);
		await expect(page).toHaveURL(/\/$/);
		await page.goto("/orchestrations");
		await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
		const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
		await expect(drawer).toContainText("触发人：管理员");
		await drawer.getByRole("button", { name: "触发运行" }).click();
		await expect(drawer.getByRole("region", { name: "运行摘要" })).toBeVisible();

		const db = new Client({ connectionString: controlPlane.database.url });
		await db.connect();
		try {
			const rows = await db.query(
				"select r.triggered_by, r.triggered_by_user_id, u.login_name from runs r left join users u on u.id = r.triggered_by_user_id",
			);
			expect(rows.rows).toEqual([
				{ triggered_by: "管理员", triggered_by_user_id: expect.any(String), login_name: "root" },
			]);
		} finally {
			await db.end();
		}
	});

	test("登出没有成功（控制面出错）：照实提示，人还是登录着，不装作已经登出；恢复之后登出成功", async ({
		page,
	}) => {
		await page.goto("/login");
		await login(page);
		await expect(accountMenu(page)).toBeVisible();
		await page.route("**/api/auth/logout", (route) =>
			route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({
					error: { code: "internal_error", message: "internal server error" },
				}),
			}),
		);
		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "登出" }).click();
		await expect(page.getByText(/登出失败/)).toBeVisible();
		await expect(page.getByText("已登出")).toBeHidden();
		await expect(page).toHaveURL(/\/$/);
		await expect(accountMenu(page)).toBeVisible();

		await page.unroute("**/api/auth/logout");
		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "登出" }).click();
		await expect(page.getByText("已登出")).toBeVisible();
		await expect(page).toHaveURL(/\/login$/);
		// 真的登出了：刷新之后还是登录页，账号接口 401。
		await page.reload();
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		const me = await page.request.get("/api/auth/me");
		expect(me.status()).toBe(401);
	});

	test("没有登录打开首页：换到登录页，不弹昵称弹窗；登录之后回到首页", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login\?/);
		expect(new URL(page.url()).searchParams.get("redirect")).toBe("/");
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		await expect(page.getByRole("dialog")).toBeHidden();
		await login(page);
		await expect(page).toHaveURL(/\/$/);
		await expect(accountMenu(page)).toBeVisible();
	});
});

test.describe("登录失效之后回到登录页", () => {
	// 打开着的事件流每 0.3 秒重新检查一次凭据（默认 30 秒）：登录在库里被注销之后，流很快就被关掉。
	test.use({ controlPlaneOptions: { initialAdmin: ADMIN, streamRecheckMs: 300 } });

	/** 在库里注销这个用户的全部登录（空闲期限到了、被管理员注销、直接改库……控制面收不到通知的那种）。 */
	async function revokeLogins(controlPlane: { database: { url: string } }) {
		const db = new Client({ connectionString: controlPlane.database.url });
		await db.connect();
		try {
			await db.query("update logins set revoked_at = now()");
		} finally {
			await db.end();
		}
	}

	test("登录着打开一个有事件流的页面，登录在库里被注销：事件流重连拿到 401，回到登录页，写明原因，登录之后回到原来的页面", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await connectAgent({ name: "agent-a" });
		await publishPackage(controlPlane);
		const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
		const runId = await triggerRun(controlPlane, scenario);

		await page.goto("/login");
		await login(page);
		await expect(accountMenu(page)).toBeVisible();
		await page.goto(`/runs/${runId}`);
		await expect(page).toHaveURL(new RegExp(`/runs/${runId}(\\?view=overview)?$`));
		await expect(page.getByRole("tablist", { name: "运行监控视图" })).toBeVisible();

		await revokeLogins(controlPlane);

		// 控制面关掉流 → 页面重连 → 401 → 回到登录页，带上原来的页面。
		await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
		const url = new URL(page.url());
		// 监控页自己在地址后面带上 ?view=overview：原样带回去。
		expect(url.searchParams.get("redirect")).toBe(`/runs/${runId}?view=overview`);
		await expect(page.getByText("登录已失效")).toBeVisible();
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();

		// 重新登录：回到刚才的监控页。
		await login(page);
		await expect(page).toHaveURL(new RegExp(`/runs/${runId}(\\?view=overview)?$`));
	});

	test("登录着停在一个轮询的页面（没有事件流），登录被注销：下一次接口请求拿到 401，回到登录页；redirect 带着查询参数，登录之后原样回来", async ({
		page,
		controlPlane,
	}) => {
		await page.goto("/login");
		await login(page);
		await expect(accountMenu(page)).toBeVisible();
		await page.goto("/runs?status=failed");
		await expect(page).toHaveURL(/\/runs\?status=failed$/);

		await revokeLogins(controlPlane);

		await expect(page).toHaveURL(/\/login\?/, { timeout: 20_000 });
		expect(new URL(page.url()).searchParams.get("redirect")).toBe("/runs?status=failed");
		await expect(page.getByText("登录已失效")).toBeVisible();

		await login(page);
		await expect(page).toHaveURL(/\/runs\?status=failed$/);
	});

	test("拿到 401 但登录其实还有效（公开地址和浏览器地址不一致时，请求被当作没登录）：不回登录页，留在原页面（#578）", async ({
		page,
	}) => {
		await page.goto("/login");
		await login(page);
		await expect(accountMenu(page)).toBeVisible();

		// 运行列表的轮询请求一律拿到 401，而 GET /auth/me 仍然说登录有效：和「登录真的失效」的区别只在后一个问题的回答。
		const events: string[] = [];
		await page.route(/\/api\/projects\/default\/runs(\?|$)/, (route) => {
			events.push("401");
			return route.fulfill({
				status: 401,
				contentType: "application/json",
				body: JSON.stringify({ error: { code: "unauthorized", message: "凭据无效" } }),
			});
		});
		page.on("response", (response) => {
			if (response.url().includes("/api/auth/me")) events.push(`me:${response.status()}`);
		});
		await page.goto("/runs");
		// 轮询每 2 秒一次：至少两个 401，每一个之后都问过 GET /auth/me，回答是登录有效。
		await expect
			.poll(() => events.filter((event) => event === "401").length, { timeout: 15_000 })
			.toBeGreaterThanOrEqual(2);
		await expect.poll(() => events.filter((event) => event === "me:200").length).toBeGreaterThan(1);
		expect(events).not.toContain("me:401");
		// 没有被带回登录页，顶栏还是登录着的账号，也没有「登录已失效」。
		await expect(page).toHaveURL(/\/runs$/);
		await expect(accountMenu(page)).toBeVisible();
		await expect(page.getByText("登录已失效")).toBeHidden();
	});

	test("从没登录过的人打开有事件流的运行页：直接换到登录页（不写「登录已失效」），登录之后回到运行页", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await connectAgent({ name: "agent-a" });
		await publishPackage(controlPlane);
		const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
		const runId = await triggerRun(controlPlane, scenario);

		await page.goto(`/runs/${runId}`);
		await expect(page).toHaveURL(/\/login\?/);
		// 监控页可能已经在地址后面带上了 ?view=overview：两种都行，原样带回去。
		expect(new URL(page.url()).searchParams.get("redirect")).toMatch(
			new RegExp(`^/runs/${runId}(\\?view=overview)?$`),
		);
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		// 不是登录失效：从来没有登录过。
		await expect(page.getByText("登录已失效")).toBeHidden();

		await login(page);
		await expect(page).toHaveURL(new RegExp(`/runs/${runId}(\\?view=overview)?$`));
		await expect(page.getByRole("tablist", { name: "运行监控视图" })).toBeVisible();
	});
});

test.describe("公开地址和浏览器打开的地址不一致", () => {
	test.use({
		controlPlaneOptions: { initialAdmin: ADMIN, publicHttpUrl: "http://sfly.example.test:8080" },
	});

	/**
	 * e2e 只能用 127.0.0.1 打开页面，它是浏览器的安全上下文（和 https、localhost 一样会发 Sec-Fetch-Site）。
	 * 提示针对的是内网 http 加 IP 或主机名访问（不是安全上下文，浏览器不发这个头）：用初始化脚本把
	 * `isSecureContext` 改成 false 来模拟。请求本身仍然是真实浏览器发的，所以登录照常。
	 */
	const asInsecureContext = (page: import("@playwright/test").Page) =>
		page.addInitScript(() => {
			Object.defineProperty(window, "isSecureContext", { value: false });
		});

	test("登录页和登录之后的控制台顶部都提示「请用 <公开地址> 打开」（登录之后写请求会被当作没登录，登出也不生效）", async ({
		page,
	}) => {
		await asInsecureContext(page);
		await page.goto("/login");
		const notice = page.locator('[data-slot="origin-notice"]');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("请用 http://sfly.example.test:8080 打开");
		await expect(notice).toHaveAttribute("role", "alert");

		// 浏览器自己发的同源请求带 Sec-Fetch-Site，登录照常；提示在控制台的顶部也在。
		await login(page);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.locator('[data-slot="origin-notice"]')).toContainText(
			"请用 http://sfly.example.test:8080 打开",
		);
	});

	test("安全上下文（https、localhost、127.0.0.1）里不提示：浏览器会发 Sec-Fetch-Site，控制面据此放行，提示是误报", async ({
		page,
	}) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		await expect(page.locator('[data-slot="origin-notice"]')).toBeHidden();
		await login(page);
		await expect(page).toHaveURL(/\/$/);
		await expect(accountMenu(page)).toBeVisible();
		await expect(page.locator('[data-slot="origin-notice"]')).toBeHidden();
		// 写请求、登出都照常（同源请求不看公开地址）。
		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "登出" }).click();
		await expect(page).toHaveURL(/\/login$/);
		expect((await page.request.get("/api/auth/me")).status()).toBe(401);
	});
});
