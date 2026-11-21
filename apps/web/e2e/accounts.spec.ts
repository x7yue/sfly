import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing } from "./support";

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

// 本地账号与登录（ADR 0029，#490）：初始化页建第一个管理员、登录页、账号菜单（修改密码、登出）、登录之后昵称弹窗不再出现、
// 写操作的身份来自登录。在 #494 之前不登录也照旧能用（昵称弹窗仍在，里面有「去登录」）。

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
const NEW_PASSWORD = "brand-new-password-1";

/** 没有预先写昵称：登录之后昵称弹窗不该出现，没登录时才弹。 */
test.use({ nickname: null });

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
		// 没有昵称也没有登录：登录页上不弹昵称弹窗（先登录）。
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

	test("账号菜单：显示名、登录名、平台管理员标记；登出回到登录页，之后写操作又要昵称", async ({
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
		// 登出之后：没有登录，页面回到没有昵称的老样子。
		await page.goto("/");
		await expect(page.getByRole("dialog", { name: "欢迎使用 sfly" })).toBeVisible();
	});

	test("修改密码：旧密码不对写在弹窗里；改成功后新密码能登录、旧密码不行", async ({ page }) => {
		await page.goto("/login");
		await login(page);
		await accountMenu(page).click();
		await page.getByRole("menuitem", { name: "修改密码…" }).click();
		const dialog = page.getByRole("dialog", { name: "修改密码" });

		await dialog.getByRole("button", { name: "修改密码" }).click();
		await expect(dialog.getByLabel("旧密码")).toBeFocused();
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

	test("没有登录也照旧能用：昵称弹窗仍在，里面有「已有账号，去登录」", async ({ page }) => {
		await page.goto("/");
		const dialog = page.getByRole("dialog", { name: "欢迎使用 sfly" });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("link", { name: "已有账号，去登录" }).click();
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
		await expect(page.getByRole("dialog")).toBeHidden();
	});
});
