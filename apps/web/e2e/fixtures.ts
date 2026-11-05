import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
// 沿用控制面测试基建（apps/server/test/support）：真实控制面、假 Agent（真实 gRPC）、
// 每个控制面独立的临时 PostgreSQL 数据库（DATABASE_URL）、手动时钟。
import { FakeAgent, type HelloInit } from "../../server/test/support/fake-agent.js";
import { ManualClock } from "../../server/test/support/manual-clock.js";
import {
	startTestControlPlane,
	type TestControlPlane,
} from "../../server/test/support/test-control-plane.js";

/** 前端构建产物（`vite build`，`pnpm test:e2e` 会先构建）。 */
const WEB_DIST = fileURLToPath(new URL("../dist", import.meta.url));

/** 手动时钟的起点；浏览器里的时间也固定在这一刻，页面上的时间显示才稳定。 */
export const START_TIME = "2026-01-01T00:00:00.000Z";

export interface E2eFixtures {
	/** 注入控制面的手动时钟。 */
	clock: ManualClock;
	/** 本测试独占的真实控制面（独立数据库），在同一端口托管前端、API 与 SSE。 */
	controlPlane: TestControlPlane;
	/** 连接一个假 Agent；测试结束时自动断开。 */
	connectAgent: (hello: HelloInit) => Promise<FakeAgent>;
	/** 浏览器里的昵称（预先写入 localStorage，跳过昵称弹窗）；设为 null 时不写。 */
	nickname: string | null;
}

export const test = base.extend<E2eFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	clock: async ({}, use) => {
		await use(new ManualClock(START_TIME));
	},
	controlPlane: async ({ clock }, use) => {
		const cp = await startTestControlPlane({ clock, webDir: WEB_DIST });
		try {
			await use(cp);
		} finally {
			await cp.close();
		}
	},
	baseURL: async ({ controlPlane }, use) => {
		await use(controlPlane.httpUrl);
	},
	connectAgent: async ({ controlPlane }, use) => {
		const agents: FakeAgent[] = [];
		await use(async (hello) => {
			const agent = await FakeAgent.connect(controlPlane.grpcUrl, hello);
			agents.push(agent);
			return agent;
		});
		await Promise.all(agents.map((a) => a.disconnect()));
	},
	nickname: ["tester", { option: true }],
	page: async ({ page, clock, nickname }, use) => {
		// Date.now() / new Date() 固定在手动时钟的当前时刻（定时器照常运行）。
		await page.clock.setFixedTime(clock.now());
		if (nickname !== null) {
			await page.addInitScript((name) => {
				window.localStorage.setItem("sfly.nickname", name);
			}, nickname);
		}
		await use(page);
	},
});

export { expect };
