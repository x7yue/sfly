import type { Page } from "@playwright/test";
import { DEFAULT_TESTER } from "../../server/test/support/credentials.js";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { FakeAssistant } from "../../server/test/support/fake-assistant.js";
import { eventAt } from "./assistant-support";
import { test as base, expect } from "./fixtures";

// 对着真的控制面加假助手服务（#541 的 `FakeAssistant`，按协议的表回应）的会话页 e2e 共用：登录、假助手服务、工作台、开始一个会话。
// 提取自 `assistant-live.spec.ts`，`session-timeline.spec.ts`（#550）也用。

export const WORKBENCH = "workbench-a";
export const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };

export const test = base.extend<{
	assistant: FakeAssistant;
	workbench: FakeAgent;
	signedIn: undefined;
}>({
	// 建会话只认用户的凭据（#547）：页面以默认项目里的普通编辑者登录（不是平台管理员），显示名是 tester（时间线上显示「tester：…」）。
	loginAs: null,
	signedIn: [
		async ({ controlPlane, context }, use) => {
			const value = await controlPlane.users.memberLogin(DEFAULT_TESTER, "default", "editor");
			await context.addCookies([
				{ name: "sfly_login", value, url: controlPlane.httpUrl, httpOnly: true, sameSite: "Lax" },
			]);
			const me = await context.request.get(`${controlPlane.httpUrl}/api/auth/me`);
			expect(await me.json()).toMatchObject({
				display_name: DEFAULT_TESTER,
				is_platform_admin: false,
				scopes: expect.not.arrayContaining(["manage"]),
			});
			await use(undefined);
		},
		{ auto: true },
	],
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	assistant: async ({}, use) => {
		const assistant = await FakeAssistant.start();
		try {
			await use(assistant);
		} finally {
			await assistant.close();
		}
	},
	controlPlaneOptions: async ({ assistant }, use) => {
		await use({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 停止慢一点的用例（假助手服务的 `stopSettleMs`）里控制面要等得住。
			sessionStopGraceMs: 10_000,
		});
	},
	// 工作台：一台在线的 Agent，上报了能力端口；控制面和助手服务都连上了才算准备好。
	workbench: async ({ connectAgent, controlPlane, assistant }, use) => {
		void controlPlane;
		const agent = await connectAgent({
			name: WORKBENCH,
			peer: { port: 7001, publicAddress: "10.0.0.5" },
		});
		await assistant.connected();
		await use(agent);
	},
});

export const timeline = (page: Page) => page.getByRole("list", { name: "会话的时间线" });
export const toolRows = (page: Page) => page.getByTestId("tool-row");

/** 在助手页写一句话、点「开始」，等到会话页打开；返回会话 ID。 */
export async function startSession(page: Page, text: string): Promise<string> {
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveAttribute("data-ready", "true");
	await page.getByRole("textbox", { name: "要做什么？" }).fill(text);
	await page.getByRole("button", { name: "开始" }).click();
	await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
	return new URL(page.url()).pathname.split("/").pop() as string;
}

/**
 * 等到页面的事件流订阅上了：不持久的事件（思考、文字增量）订阅之前推的就丢了，所以反复推「思考中」，
 * 直到页面上看到它——之后推的增量一定收得到。
 */
export async function streamReady(page: Page, assistant: FakeAssistant, id: string) {
	await expect
		.poll(async () => {
			assistant.emit(id, 1, { type: "thinking" }, eventAt());
			return page.getByTestId("thinking").count();
		})
		.toBe(1);
}
