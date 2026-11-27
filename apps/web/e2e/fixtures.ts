import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { DEFAULT_TESTER } from "../../server/test/support/credentials.js";
// 沿用控制面测试基建（apps/server/test/support）：真实控制面、假 Agent（真实 gRPC）、
// 每个控制面独立的临时 PostgreSQL 数据库（DATABASE_URL）、手动时钟。
import { FakeAgent, type HelloInit } from "../../server/test/support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "../../server/test/support/fake-feishu.js";
import { ManualClock } from "../../server/test/support/manual-clock.js";
import {
	startTestControlPlane,
	type TestControlPlane,
} from "../../server/test/support/test-control-plane.js";
import { E2E_TEMPLATE_ENV } from "./global-setup.js";

/** 前端构建产物（`vite build`，`pnpm test:e2e` 会先构建）。 */
const WEB_DIST = fileURLToPath(new URL("../dist", import.meta.url));
/** 仓库里的用户文档（ADR 0013），「开发文档」页渲染它。 */
const DOCS_DIR = fileURLToPath(new URL("../../../docs/guide", import.meta.url));

/**
 * `controlPlane` 夹具建立和拆除各自的时限（毫秒），不占用例自己的 30 秒（playwright.config.ts 的 `timeout`）：
 * 建立要从模板复制出库（迁移在整个运行开始前就做完了，控制面启动时的迁移什么也不做）、起控制面，拆除要关控制面、删库；
 * 机器忙的时候（整份跑 e2e，同时还有别的构建和测试）这些会变慢，以前碰巧落在这两步里的用例就因「夹具超过 30 秒」失败，
 * 而用例本身没有问题（#613）。`fixture-timeout.spec.ts` 守着这个时限。
 * 注意：`baseURL` 依赖 `controlPlane`，Playwright 给每个用例、每个 `beforeAll` / `afterAll` 钩子都建一遍控制面，不管用不用得到；
 * 钩子里赋的变量在那时还没有值。夹具建立超时之后，建到一半的测试库和控制面没人收拾（120 秒的时限让它很少见）。
 */
export const CONTROL_PLANE_FIXTURE_TIMEOUT_MS = 120_000;

/**
 * 手动时钟的起点；浏览器里的时间也固定在这一刻。页面上的"现在"按控制面时间算（接口响应和 SSE 心跳带回来，
 * ADR 0018），所以推进手动时钟后页面会跟上，不需要再拨浏览器时间。
 */
export const START_TIME = "2026-01-01T00:00:00.000Z";

/** e2e 里登录的空闲期限：一年。 */
const LOGIN_IDLE_MS = 365 * 24 * 3_600_000;

export interface E2eFixtures {
	/** 注入控制面的手动时钟。 */
	clock: ManualClock;
	/** 本测试独占的真实控制面（独立数据库），在同一端口托管前端、API 与 SSE。 */
	controlPlane: TestControlPlane;
	/**
	 * 连接一个假 Agent（默认上报控制面的版本，时钟与控制面一致：指标点的控制面时间就是给出的 Unix 秒，
	 * 见 FakeAgent.connect 的 clock 选项）；测试结束时自动断开。要模拟 Agent 时间不一致，在 hello 里写 agentTimeUnixMs；
	 * `clock: false` 时是不上报时钟读数的旧版本 Agent。`preparing: true` 时停在准备环境，调用 `agent.ready()` 才准备好
	 * （见 FakeAgent.connect）。
	 */
	connectAgent: (
		hello: HelloInit,
		options?: { clock?: false; preparing?: boolean },
	) => Promise<FakeAgent>;
	/** 假的飞书 Webhook 服务（ADR 0020）：飞书机器人的 Webhook 地址指向它；测试结束时自动关闭。 */
	feishu: FakeFeishu;
	/**
	 * 浏览器以哪个用户登录着（#493）：用例开始前为这个名字的用户（`TestUsers`，平台管理员、默认项目的项目管理员）
	 * 建一个登录，Cookie 放进浏览器。测没登录时的样子（登录页、初始化、没登录被带到登录页）的用例设为 null：空的登录状态。
	 */
	loginAs: string | null;
	/**
	 * 覆盖控制面的选项：对外地址、版本号（默认是实际监听地址和 package.json 的版本；视觉回归里固定它们，
	 * 文档里替换出来的地址、版本号才不随端口和发版变化）、用户文档目录（默认仓库的 docs/guide）和单任务的指标上限
	 * （字节，每点 28 字节；调小后用来触发「截断」）、按运行读日志时单次请求的扫描量上限（字节；调小后
	 * 筛选很少匹配时一页读不到行，用来触发「接着往前读」）、允许跨域调用的来源名单（`SFLY_CORS_ORIGINS`，不设置时允许所有来源）、
	 * 初始管理员（`SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD`：不给时空库启动会生成初始化码，写在数据目录的 setup-code 文件里）。
	 */
	controlPlaneOptions: {
		publicHttpUrl?: string;
		version?: string;
		docsDir?: string;
		metricLimitBytes?: number;
		logScanBytes?: number;
		corsOrigins?: readonly string[];
		/** 助手服务（假的，`FakeAssistant`）的地址、共享密钥、工作台的 Agent 名称和重连间隔：不给时助手没有配置。 */
		assistantUrl?: string;
		assistantSecret?: string;
		workbenchAgent?: string;
		assistantReconnectMs?: { min: number; max: number };
		/** 停止一轮时控制面等助手服务带回结局最多多久（毫秒，默认 300）：测试里让假助手服务的停止慢一点（`stopSettleMs`）时放长。 */
		sessionStopGraceMs?: number;
		initialAdmin?: { loginName: string; password: string; displayName?: string };
		/** 打开着的事件流多久重新检查一次凭据（毫秒，默认 30 秒）：登录失效之后流多久被关掉。 */
		streamRecheckMs?: number;
		/** 登录闲置多久失效（毫秒，默认 12 小时）：测试要让控制面时钟走过几天又不想被登录失效打断时放长。 */
		loginIdleMs?: number;
	};
}

export const test = base.extend<E2eFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	clock: async ({}, use) => {
		await use(new ManualClock(START_TIME));
	},
	controlPlaneOptions: [{}, { option: true }],
	controlPlane: [
		async ({ clock, controlPlaneOptions }, use) => {
			const cp = await startTestControlPlane({
				clock,
				webDir: WEB_DIST,
				docsDir: DOCS_DIR,
				// 测试库从 global-setup.ts 建好的、已迁移的模板库复制；没有模板（不经这份配置运行）时建空库、自己迁移。
				template: process.env[E2E_TEMPLATE_ENV],
				// SSE 心跳调快：推进手动时钟后，页面很快就从心跳里得到新的控制面时间。
				sseHeartbeatMs: 250,
				// 用例会把控制面时钟拨过几小时、几天：浏览器的登录不因空闲失效。
				loginIdleMs: LOGIN_IDLE_MS,
				...controlPlaneOptions,
			});
			try {
				await use(cp);
			} finally {
				await cp.close();
			}
		},
		{ timeout: CONTROL_PLANE_FIXTURE_TIMEOUT_MS },
	],
	baseURL: async ({ controlPlane }, use) => {
		await use(controlPlane.httpUrl);
	},
	connectAgent: async ({ controlPlane, clock }, use) => {
		const agents: FakeAgent[] = [];
		await use(async (hello, options = {}) => {
			// 默认与控制面同版本（版本不一致的 Agent 不会被派任务，ADR 0014）。
			const agent = await FakeAgent.connect(
				controlPlane.grpcUrl,
				{ agentVersion: controlPlane.version, ...hello },
				{ ...(options.clock === false ? {} : { clock }), preparing: options.preparing },
			);
			agents.push(agent);
			return agent;
		});
		await Promise.all(agents.map((a) => a.disconnect()));
	},
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	feishu: async ({}, use) => {
		const feishu = await startFakeFeishu();
		try {
			await use(feishu);
		} finally {
			await feishu.close();
		}
	},
	loginAs: [DEFAULT_TESTER, { option: true }],
	page: async ({ page, clock, controlPlane, loginAs }, use) => {
		// Date.now() / new Date() 固定在手动时钟的当前时刻（定时器照常运行）。
		await page.clock.setFixedTime(clock.now());
		if (loginAs !== null) {
			const value = await controlPlane.users.loginCookie(loginAs);
			await page
				.context()
				.addCookies([
					{ name: "sfly_login", value, url: controlPlane.httpUrl, httpOnly: true, sameSite: "Lax" },
				]);
		}
		await use(page);
	},
});

export { expect };
