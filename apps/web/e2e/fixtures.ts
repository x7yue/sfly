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
/** 仓库里的用户文档（ADR 0013），「开发文档」页渲染它。 */
const DOCS_DIR = fileURLToPath(new URL("../../../docs/guide", import.meta.url));

/**
 * 手动时钟的起点；浏览器里的时间也固定在这一刻。页面上的"现在"按控制面时间算（接口响应和 SSE 心跳带回来，
 * ADR 0018），所以推进手动时钟后页面会跟上，不需要再拨浏览器时间。
 */
export const START_TIME = "2026-01-01T00:00:00.000Z";

export interface E2eFixtures {
	/** 注入控制面的手动时钟。 */
	clock: ManualClock;
	/** 本测试独占的真实控制面（独立数据库），在同一端口托管前端、API 与 SSE。 */
	controlPlane: TestControlPlane;
	/**
	 * 连接一个假 Agent（默认上报控制面的版本，时钟与控制面一致：指标点的控制面时间就是给出的 Unix 秒，
	 * 见 FakeAgent.connect 的 clock 选项）；测试结束时自动断开。要模拟 Agent 时间不一致，在 hello 里写 agentTimeUnixMs。
	 */
	connectAgent: (hello: HelloInit) => Promise<FakeAgent>;
	/** 浏览器里的昵称（预先写入 localStorage，跳过昵称弹窗）；设为 null 时不写。 */
	nickname: string | null;
	/**
	 * 覆盖控制面的选项：对外地址、版本号（默认是实际监听地址和 package.json 的版本；视觉回归里固定它们，
	 * 文档里替换出来的地址、版本号才不随端口和发版变化）、用户文档目录（默认仓库的 docs/guide）和单任务的指标上限
	 * （字节，每点 28 字节；调小后用来触发「截断」）。
	 */
	controlPlaneOptions: {
		publicHttpUrl?: string;
		version?: string;
		docsDir?: string;
		metricLimitBytes?: number;
	};
}

export const test = base.extend<E2eFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	clock: async ({}, use) => {
		await use(new ManualClock(START_TIME));
	},
	controlPlaneOptions: [{}, { option: true }],
	controlPlane: async ({ clock, controlPlaneOptions }, use) => {
		const cp = await startTestControlPlane({
			clock,
			webDir: WEB_DIST,
			docsDir: DOCS_DIR,
			// SSE 心跳调快：推进手动时钟后，页面很快就从心跳里得到新的控制面时间。
			sseHeartbeatMs: 250,
			...controlPlaneOptions,
		});
		try {
			await use(cp);
		} finally {
			await cp.close();
		}
	},
	baseURL: async ({ controlPlane }, use) => {
		await use(controlPlane.httpUrl);
	},
	connectAgent: async ({ controlPlane, clock }, use) => {
		const agents: FakeAgent[] = [];
		await use(async (hello) => {
			// 默认与控制面同版本（版本不一致的 Agent 不会被派任务，ADR 0014）。
			const agent = await FakeAgent.connect(
				controlPlane.grpcUrl,
				{ agentVersion: controlPlane.version, ...hello },
				{ clock },
			);
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
