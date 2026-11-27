import type { Page } from "@playwright/test";
import { FakeAgent } from "../../server/test/support/fake-agent.js";
import { setAuthKind, signInAs, signInAsAdmin } from "./agent-admin-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// Agent 页的凭据弹窗、停用和恢复（#492 D）：签发（原值只显示一次）、吊销、轮换、给还没连过的名字签发、停用和恢复的确认。
// 凭据原值是高风险的东西：这里反复查它只出现在签发那一刻的弹窗里，不在关掉之后的页面、刷新之后、列表接口、浏览器存储、URL 里。

// 控制面版本固定为 1.2.3、对外地址固定：安装命令里的地址是它。
test.use({
	controlPlaneOptions: { version: "1.2.3", publicHttpUrl: "http://sfly.internal:8080" },
});

const RAW = /sfly_agt_[0-9a-f]{20,}/;
const dialog = (page: Page) => page.getByRole("dialog");
const rack = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const issuedToken = (page: Page) => dialog(page).locator("[data-issued-credential]");

/** 页面此刻（DOM 全文、标题、地址、两种浏览器存储）里有没有这一段文字。 */
async function pageHolds(page: Page, text: string): Promise<boolean> {
	return page.evaluate(
		(needle) =>
			[
				document.documentElement.outerHTML,
				document.title,
				location.href,
				JSON.stringify({ ...localStorage }),
				JSON.stringify({ ...sessionStorage }),
				// 输入框的当前值不在 outerHTML 里（属性不随输入变），单独查。
				...[...document.querySelectorAll("input, textarea")].map(
					(el) => (el as HTMLInputElement).value,
				),
			].some((where) => where.includes(needle)),
		text,
	);
}

test.describe("签发、吊销、轮换", () => {
	test("签发：弹窗里显示一次原值和写好名字的安装命令（命令里没有原值）；显示的时候 Esc、点遮罩都关不掉，只能点「我已保存，完成」", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAsAdmin(context, controlPlane);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();

		// 列表：这台 Agent 已有的一个凭据（连接用的），只有前缀。
		await expect(dialog(page).getByRole("table", { name: "凭据列表" })).toBeVisible();
		await expect(dialog(page).locator("[data-credential-state]")).toHaveCount(1);
		await expect(dialog(page).locator('[data-slot="credential-prefix"]').first()).toHaveText(
			/^sfly_agt_[0-9a-f]+…$/,
		);

		await dialog(page).getByRole("button", { name: "签发新凭据" }).click();
		await expect(dialog(page)).toContainText("的凭据已签发");
		await expect(dialog(page)).toContainText("只显示这一次");
		const raw = await issuedToken(page).inputValue();
		expect(raw).toMatch(RAW);

		// 写好名字的安装命令：先 read -rs 读入凭据，再运行安装脚本；原值不在命令里，不在命令行参数里。
		const command = dialog(page).locator('[data-slot="code-block"]');
		await expect(command).toHaveText(
			"read -rs SFLY_TOKEN && export SFLY_TOKEN\ncurl -fsSL http://sfly.internal:8080/install.sh | sh -s -- --name agent-a",
		);
		expect(await command.innerText()).not.toContain(raw.slice(0, 16));
		expect(await command.innerText()).not.toContain("--token");

		// 一键复制：复制的是原值；复制安装命令的是命令（不是原值）。
		await dialog(page).getByRole("button", { name: "复制凭据原值" }).click();
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
		await command.getByRole("button", { name: "复制" }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toContain("read -rs SFLY_TOKEN");
		expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(raw);

		// 显示原值的时候：没有右上角的关闭按钮，Esc、点遮罩都不关。
		await expect(dialog(page).getByRole("button", { name: "关闭" })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(issuedToken(page)).toHaveValue(raw);
		await page.mouse.click(8, 8);
		await expect(issuedToken(page)).toHaveValue(raw);

		// 这个凭据真的能用：用它连控制面（名字对得上）。
		const connected = await FakeAgent.connect(controlPlane.grpcUrl, {
			name: "agent-a",
			agentVersion: "1.2.3",
			token: raw,
		});
		await connected.disconnect();

		await dialog(page).getByRole("button", { name: "我已保存，完成" }).click();
		// 回到列表：两个凭据，其中有刚签发的这个（只有前缀）。
		await expect(dialog(page).locator("[data-credential-state]")).toHaveCount(2);
		await expect(
			dialog(page)
				.locator('[data-slot="credential-prefix"]')
				.filter({ hasText: raw.slice(0, 13) }),
		).toHaveText(`${raw.slice(0, 13)}…`);
		expect(await pageHolds(page, raw.slice(10))).toBe(false);
	});

	test("原值只出现一次：关掉弹窗、再打开、刷新页面、列表接口里都拿不到，也不在 URL 和浏览器存储里", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		const { headers } = await signInAsAdmin(context, controlPlane);
		await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		const requests: string[] = [];
		page.on("request", (request) => requests.push(request.url()));
		await page.goto("/agents");
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();
		await dialog(page).getByRole("button", { name: "签发新凭据" }).click();
		const raw = await issuedToken(page).inputValue();
		expect(raw).toMatch(RAW);
		const secret = raw.slice(10);
		// 显示的时候页面里有（输入框的值）。
		expect(await pageHolds(page, secret)).toBe(true);

		await dialog(page).getByRole("button", { name: "我已保存，完成" }).click();
		expect(await pageHolds(page, secret)).toBe(false);

		// 关掉再打开：列表里只有前缀。
		await dialog(page).getByRole("button", { name: "关闭" }).click();
		await expect(dialog(page)).toBeHidden();
		expect(await pageHolds(page, secret)).toBe(false);
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();
		await expect(dialog(page).locator("[data-credential-state]")).toHaveCount(2);
		expect(await pageHolds(page, secret)).toBe(false);
		await page.keyboard.press("Escape");
		await expect(dialog(page)).toBeHidden();

		// 刷新页面。
		await page.reload();
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();
		await expect(dialog(page).locator("[data-credential-state]")).toHaveCount(2);
		expect(await pageHolds(page, secret)).toBe(false);

		// 列表接口（带管理员的令牌直接读）和 Agent 列表接口的响应里没有原值，也没有 token 字段。
		for (const path of ["/agents/agent-a/credentials", "/agents"]) {
			const body = await (await controlPlane.fetch(path, { headers })).text();
			expect(body).not.toContain(secret);
			expect(body).not.toContain('"token"');
		}
		// 没有哪个请求的地址里带着原值。
		expect(requests.filter((url) => url.includes(secret))).toEqual([]);
	});

	test("给还没连过的名字签发：名称过和控制面同一条规则（空的、看不见的字符、超过 64 个字符都不行，不发请求），签发之后能用它连上来，Agent 页出现这台", async ({
		page,
		context,
		controlPlane,
	}) => {
		await signInAsAdmin(context, controlPlane);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const posts: string[] = [];
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/credentials")) {
				posts.push(request.url());
			}
		});
		await page.goto("/agents");
		await page.getByRole("button", { name: "为新 Agent 签发凭据" }).click();
		const name = dialog(page).getByLabel("Agent 名称");
		const submit = dialog(page).getByRole("button", { name: "签发凭据" });

		await submit.click();
		await expect(dialog(page)).toContainText("填写 Agent 的名称");
		await name.fill("a​b");
		await expect(dialog(page)).toContainText("第 2 个字符是 U+200B");
		await name.fill("x".repeat(65));
		await expect(dialog(page)).toContainText("Agent 的名称不能超过 64 个字符");
		await expect(submit).toBeDisabled();
		expect(posts).toEqual([]);

		// 64 个字符放得下。
		await name.fill("x".repeat(64));
		await expect(dialog(page)).not.toContainText("不能超过");
		await name.fill("worker-9");
		await submit.click();
		await expect(dialog(page)).toContainText("的凭据已签发");
		const raw = await issuedToken(page).inputValue();
		expect(raw).toMatch(RAW);
		await expect(dialog(page).locator('[data-slot="code-block"]')).toContainText("--name worker-9");
		await dialog(page).getByRole("button", { name: "我已保存，完成" }).click();
		// 完成之后留在这个名字的列表里，有刚签发的那一个。
		await expect(dialog(page).locator("[data-credential-state]")).toHaveCount(1);
		await dialog(page).getByRole("button", { name: "关闭" }).click();

		// 用它连上来：Agent 页出现这台。
		const agent = await FakeAgent.connect(controlPlane.grpcUrl, {
			name: "worker-9",
			agentVersion: "1.2.3",
			token: raw,
		});
		try {
			await expect(rack(page, "worker-9")).toBeVisible({ timeout: 15_000 });
			// 名字不对的连接被拒绝：凭据只对签发时的那个名字有效。
			await expect(
				FakeAgent.connect(controlPlane.grpcUrl, {
					name: "worker-10",
					agentVersion: "1.2.3",
					token: raw,
				}),
			).rejects.toThrow();
		} finally {
			await agent.disconnect();
		}
	});

	test("吊销：确认框写明立即失效、连接断开；只有一个有效凭据时多写一句；吊销之后用它连着的 Agent 被断开，列表里是「已吊销」", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAsAdmin(context, controlPlane);
		const agent = await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();
		const row = dialog(page).locator("[data-credential-state]");
		await expect(row).toHaveCount(1);
		await row.getByRole("button", { name: /^吊销 sfly_agt_/ }).click();

		await expect(dialog(page)).toContainText("吊销后立即失效");
		await expect(dialog(page)).toContainText("用它连着的连接会断开");
		await expect(dialog(page)).toContainText("不能撤销");
		await expect(dialog(page).locator('[data-slot="revoke-only-active"]')).toContainText(
			"这是这个名字唯一有效的凭据",
		);
		// 取消：什么都没变，Agent 还连着。
		await dialog(page).getByRole("button", { name: "取消" }).click();
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute("data-credential-state", "active");
		expect(agent.ended).toBe(false);

		await row.getByRole("button", { name: /^吊销 sfly_agt_/ }).click();
		await dialog(page).getByRole("button", { name: "吊销", exact: true }).click();
		await expect(row).toHaveAttribute("data-credential-state", "revoked");
		await expect(row.getByRole("button", { name: /^吊销/ })).toHaveCount(0);
		await expect.poll(() => agent.ended).toBe(true);
	});

	test("轮换：列表里有轮换的三步；先签发新的，用新的连上之后吊销旧的；两个有效凭据时吊销确认不再写「唯一有效」", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAsAdmin(context, controlPlane);
		const old = await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await page.getByRole("button", { name: "agent-a 的凭据" }).click();
		const guide = dialog(page).locator('[data-slot="rotate-guide"]');
		await expect(guide).toContainText("签发新凭据");
		await expect(guide.getByRole("listitem")).toHaveCount(3);
		await expect(guide).toContainText("agent.env");
		await expect(guide).toContainText("再回到这里吊销旧的");

		// 1. 签发新的。
		await dialog(page).getByRole("button", { name: "签发新凭据" }).click();
		const raw = await issuedToken(page).inputValue();
		// 签发之后弹窗里还有「换掉已装好的 Agent 的凭据」的几步（换进 agent.env、重启）。
		await expect(dialog(page)).toContainText("SFLY_TOKEN=");
		await expect(dialog(page)).toContainText("systemctl --user restart sfly-agent");
		await dialog(page).getByRole("button", { name: "我已保存，完成" }).click();
		// 2. 用新的连上来（同名的新连接顶掉旧连接）。
		const fresh = await FakeAgent.connect(controlPlane.grpcUrl, {
			name: "agent-a",
			agentVersion: "1.2.3",
			token: raw,
		});
		try {
			await expect.poll(() => old.ended).toBe(true);
			// 3. 吊销旧的（前缀不是新凭据的那一行）。两个有效的凭据：确认框不写「唯一有效」。
			const rows = dialog(page).locator("[data-credential-state]");
			await expect(rows).toHaveCount(2);
			const oldRow = rows.filter({ hasNotText: raw.slice(0, 13) });
			const newRow = rows.filter({ hasText: raw.slice(0, 13) });
			await oldRow.getByRole("button", { name: /^吊销 sfly_agt_/ }).click();
			await expect(dialog(page)).toContainText("吊销后立即失效");
			await expect(dialog(page).locator('[data-slot="revoke-only-active"]')).toHaveCount(0);
			await dialog(page).getByRole("button", { name: "吊销", exact: true }).click();
			await expect(oldRow).toHaveAttribute("data-credential-state", "revoked");
			await expect(newRow).toHaveAttribute("data-credential-state", "active");
			// 新的凭据连着的 Agent 不受影响。
			expect(fresh.ended).toBe(false);
		} finally {
			await fresh.disconnect();
		}
	});
});

test.describe("停用和恢复", () => {
	test("停用：确认框写明断开连接、手上的任务按失联处理、停用停不下那台机器上正在跑的任务；取消什么都不变，确认后断开、页面写「已停用」，恢复之后能重新连上", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAsAdmin(context, controlPlane);
		await publishPackage(controlPlane);
		const agent = await connectAgent({
			name: "agent-a",
			agentVersion: "1.2.3",
			slots: 2,
			installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
		});
		await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "巡检", scenarioUsing("agent-a")),
		);
		await agent.nextAssign();
		await page.goto("/agents");
		const status = rack(page, "agent-a").locator("header [data-status]");
		await expect(status).toHaveText("在线");
		// 页面每 5 秒重新读一次 Agent 列表：读到这个任务占着槽位之后再打开确认框。
		await expect(rack(page, "agent-a")).toContainText("1 / 2 占用", { timeout: 15_000 });

		await rack(page, "agent-a").getByRole("button", { name: "停用 agent-a" }).click();
		await expect(dialog(page)).toContainText("停用后它立即断开连接");
		await expect(dialog(page).locator('[data-slot="disable-running"]')).toContainText(
			"它现在有 1 个任务在执行",
		);
		await expect(dialog(page).locator('[data-slot="disable-running"]')).toContainText("agent_lost");
		await expect(dialog(page).locator('[data-slot="disable-running"]')).toContainText("重试");
		await expect(dialog(page).locator('[data-slot="disable-not-stopped"]')).toContainText(
			"停用不会停下那台机器上正在跑的任务",
		);
		await expect(dialog(page).locator('[data-slot="disable-not-stopped"]')).toContainText(
			"systemctl --user stop sfly-agent",
		);
		await expect(dialog(page)).toContainText("被 1 个场景引用");
		// 取消：什么都没变。
		await dialog(page).getByRole("button", { name: "取消" }).click();
		await expect(dialog(page)).toBeHidden();
		expect(agent.ended).toBe(false);
		await expect(status).toHaveText("在线");

		await rack(page, "agent-a").getByRole("button", { name: "停用 agent-a" }).click();
		await dialog(page).getByRole("button", { name: "停用", exact: true }).click();
		await expect(dialog(page)).toBeHidden();
		await expect.poll(() => agent.ended).toBe(true);
		await expect(status).toHaveText("已停用", { timeout: 15_000 });
		// 停用的 Agent 连不上：不论带不带凭据。
		await expect(
			FakeAgent.connect(controlPlane.grpcUrl, { name: "agent-a", agentVersion: "1.2.3" }),
		).rejects.toThrow();

		// 按钮变成「恢复」，确认框写明恢复之后会怎样。
		await rack(page, "agent-a").getByRole("button", { name: "恢复 agent-a" }).click();
		await expect(dialog(page)).toContainText("恢复之后这台 Agent 可以重新连接");
		await expect(dialog(page)).toContainText("如果是因为凭据泄露才停用的");
		await dialog(page).getByRole("button", { name: "恢复", exact: true }).click();
		await expect(dialog(page)).toBeHidden();
		const back = await FakeAgent.connect(controlPlane.grpcUrl, {
			name: "agent-a",
			agentVersion: "1.2.3",
		});
		try {
			await expect(status).toHaveText("在线", { timeout: 15_000 });
		} finally {
			await back.disconnect();
		}
	});

	test("没有任务、没被场景引用的 Agent：确认框写「没有任务在执行」，不写被引用", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAsAdmin(context, controlPlane);
		await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await rack(page, "agent-a").getByRole("button", { name: "停用 agent-a" }).click();
		await expect(dialog(page).locator('[data-slot="disable-running"]')).toHaveText(
			"它现在没有任务在执行。",
		);
		await expect(dialog(page)).not.toContainText("个场景引用");
	});
});

test.describe("谁看得到这些按钮", () => {
	// 页面按 `CurrentUser.scopes` 里有没有「管理」显示按钮；显示与否和接口的 200/403 要一致（服务端照样检查）。
	const WHO = [
		{ name: "项目管理员", login: "pa", role: "project_admin", shown: true },
		{ name: "编辑者", login: "ed", role: "editor", shown: false },
		{ name: "只读成员", login: "ro", role: "read_only", shown: false },
		{ name: "平台管理员（不是成员）", login: "plat", role: null, platformAdmin: true, shown: true },
	] as const;
	for (const who of WHO) {
		test(`${who.name}：按钮${who.shown ? "显示" : "不显示"}，管理类接口${who.shown ? "204" : "403"}，两边一致`, async ({
			page,
			context,
			controlPlane,
			connectAgent,
		}) => {
			await signInAs(context, controlPlane, who);
			await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
			await page.goto("/agents");
			await expect(rack(page, "agent-a")).toBeVisible();
			const want = who.shown ? 1 : 0;
			await expect(page.getByRole("button", { name: "为新 Agent 签发凭据" })).toHaveCount(want);
			await expect(page.getByRole("button", { name: "agent-a 的凭据" })).toHaveCount(want);
			await expect(page.getByRole("button", { name: "停用 agent-a" })).toHaveCount(want);
			// 同一个登录在页面里（同源）调管理类接口：恢复一台没有停用的 Agent，什么都不改。
			const status = await page.evaluate(
				async () => (await fetch("/api/agents/agent-a/enable", { method: "POST" })).status,
			);
			expect(status).toBe(who.shown ? 204 : 403);
		});
	}

	test("范围跟着身份走：打开 Agent 页时重新问一次，管理员被降级之后再打开就看不到按钮了", async ({
		page,
		context,
		controlPlane,
		connectAgent,
	}) => {
		await signInAs(context, controlPlane, { login: "pa", role: "project_admin" });
		await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await expect(page.getByRole("button", { name: "agent-a 的凭据" })).toBeVisible();
		// 管理员在别处被降成编辑者：控制面里的角色变了，页面还开着，按钮还在（点了服务端拒绝）。
		await signInAs(context, controlPlane, { login: "pa", role: "editor" });
		// 换一个页面再回来：身份重新读，按钮没了。
		await page.getByRole("link", { name: /^节点包/ }).click();
		await page.getByRole("link", { name: /Agent 管理/ }).click();
		await expect(rack(page, "agent-a")).toBeVisible();
		await expect(page.getByRole("button", { name: "agent-a 的凭据" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "为新 Agent 签发凭据" })).toHaveCount(0);
	});

	test("没有登录（昵称模式）的人看不到凭据、停用的按钮，也看不到「为新 Agent 签发凭据」；接口也要登录", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
		await page.goto("/agents");
		await expect(rack(page, "agent-a")).toBeVisible();
		await expect(page.getByRole("button", { name: "为新 Agent 签发凭据" })).toHaveCount(0);
		await expect(rack(page, "agent-a").getByRole("button", { name: "agent-a 的凭据" })).toHaveCount(
			0,
		);
		await expect(rack(page, "agent-a").getByRole("button", { name: "停用 agent-a" })).toHaveCount(
			0,
		);
		// 页面不给看，接口本来就拒绝：不带凭据的请求是 401。
		const refused = await controlPlane.fetch("/agents/agent-a/credentials");
		expect(refused.status).toBe(401);
	});
});

test("机架头部：凭据提示排在名称、版本后面（不把名称推到右边），右侧是「凭据」「停用」按钮", async ({
	page,
	context,
	controlPlane,
	connectAgent,
}) => {
	await signInAsAdmin(context, controlPlane);
	await connectAgent({ name: "agent-shared", agentVersion: "1.2.3" });
	await setAuthKind(controlPlane, "agent-shared", "shared");
	await page.goto("/agents");
	const header = rack(page, "agent-shared").locator("header");
	await expect(header.locator('[data-slot="auth-notice"]')).toContainText("用共享令牌连接");
	const name = await header.getByRole("heading", { name: "agent-shared" }).boundingBox();
	const notice = await header.locator('[data-slot="auth-notice"]').boundingBox();
	const credentials = await header
		.getByRole("button", { name: "agent-shared 的凭据" })
		.boundingBox();
	// 名称在提示前面（同一行时在左边，换行时在上面）；提示在「凭据」按钮的左边或上面，不压住它。
	expect(name).not.toBeNull();
	expect(notice).not.toBeNull();
	const before = (name?.y ?? 0) < (notice?.y ?? 0) - 1 || (name?.x ?? 0) < (notice?.x ?? 0);
	expect(before).toBe(true);
	const overlaps =
		(notice?.x ?? 0) < (credentials?.x ?? 0) + (credentials?.width ?? 0) &&
		(credentials?.x ?? 0) < (notice?.x ?? 0) + (notice?.width ?? 0) &&
		(notice?.y ?? 0) < (credentials?.y ?? 0) + (credentials?.height ?? 0) &&
		(credentials?.y ?? 0) < (notice?.y ?? 0) + (notice?.height ?? 0);
	expect(overlaps).toBe(false);
});

test("「如何接入 Agent」弹窗：写的是按台签发，命令用 read -rs 传凭据；不再说「配置了共享令牌时加上 --token」", async ({
	page,
	context,
	controlPlane,
	connectAgent,
}) => {
	await signInAsAdmin(context, controlPlane);
	await connectAgent({ name: "agent-a", agentVersion: "1.2.3" });
	await page.goto("/agents");
	await page.getByRole("button", { name: "如何接入 Agent" }).click();
	const help = page.getByRole("dialog", { name: "接入 Agent" });
	await expect(help).toContainText("每台 Agent 用自己的凭据连接");
	await expect(help).toContainText("为新 Agent 签发凭据");
	await expect(help).toContainText("SFLY_TOKEN");
	await expect(help).not.toContainText("配置了共享令牌时加上");
	await expect(help).not.toContainText("--token");
});
