import { expect, type Locator, type Page } from "@playwright/test";
import type { RunNotificationTrigger } from "@sfly/schema";
import { actAs } from "../../server/test/support/credentials.js";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
} from "../../server/test/support/package-archive.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";

/** 端到端测试里通过 HTTP API 准备数据（根路径 API，与 CLI / Agent 一样不经过 /api 前缀）。 */

async function ok(res: Response, what: string): Promise<Response> {
	if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
	return res;
}

/** 发布一个节点包（默认是 demo-checks@1.2.0，含 http_check 与 ping 两个节点类型）。 */
export async function publishPackage(
	cp: TestControlPlane,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const archive = packageArchive(packageMetadata(overrides));
	await ok(await cp.fetch("/projects/default/packages", publishInit(archive)), "发布节点包");
}

/** 新建场景，给了文档时保存为第 1 版；返回场景 ID。 */
export async function createScenario(
	cp: TestControlPlane,
	name: string,
	document?: Record<string, unknown>,
): Promise<string> {
	const json = (body: unknown): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify(body),
	});
	const res = await ok(await cp.fetch("/orchestrations", json({ name })), "新建场景");
	const { id } = (await res.json()) as { id: string };
	if (document) {
		await ok(
			await cp.fetch(`/orchestrations/${id}/versions`, json({ base_version: 0, document })),
			"保存场景版本",
		);
	}
	return id;
}

/** 触发场景的最新版本，返回运行 ID。 */
export async function triggerRun(cp: TestControlPlane, scenarioId: string): Promise<string> {
	const res = await ok(
		await cp.fetch(`/orchestrations/${scenarioId}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json", ...actAs("tester") },
			body: JSON.stringify({ params: {} }),
		}),
		"触发运行",
	);
	return ((await res.json()) as { id: string }).id;
}

/**
 * 造一个失败的运行并等它结束，返回运行 ID。运行通知是兜底，只在失败（或取消）时发（#446），成功的运行不发；
 * 要看到「运行结束时发的卡片」就用它：触发场景的最新版本，让 `agent` 把派发来的第一个任务以 `message` 失败
 * （`location` 是出错位置，不给表示没有），等运行的状态变成「失败」。场景的节点要派发给这个 Agent
 * （例如 `scenarioUsing(agent.name)`，节点包要先发布），第一个任务所在的节点不配置重试。
 */
export async function failRun(
	cp: TestControlPlane,
	agent: FakeAgent,
	scenarioId: string,
	options: { message?: string; location?: string } = {},
): Promise<string> {
	const runId = await triggerRun(cp, scenarioId);
	await agent.fail(
		await agent.nextAssign(),
		options.message,
		undefined,
		undefined,
		options.location,
	);
	await expect
		.poll(
			async () => ((await (await cp.fetch(`/runs/${runId}`)).json()) as { status: string }).status,
		)
		.toBe("failed");
	return runId;
}

/** 登记一个飞书机器人（Webhook 地址一般是 `feishu.webhookUrl()`，指向假的飞书服务）。 */
export async function createFeishuBot(
	cp: TestControlPlane,
	name: string,
	webhookUrl: string,
): Promise<void> {
	await ok(
		await cp.fetch("/feishu-bots", {
			method: "POST",
			headers: { "content-type": "application/json", ...actAs("tester") },
			body: JSON.stringify({ name, webhook_url: webhookUrl }),
		}),
		"登记飞书机器人",
	);
}

/** 配置场景的运行通知（#232；只写要改的项，其余保持不变）。 */
export async function setRunNotification(
	cp: TestControlPlane,
	scenarioId: string,
	settings: {
		bot?: string | null;
		trigger?: RunNotificationTrigger;
		title?: string;
		note?: string;
	},
): Promise<void> {
	await ok(
		await cp.fetch(`/orchestrations/${scenarioId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...actAs("tester") },
			body: JSON.stringify({ run_notification: settings }),
		}),
		"配置运行通知",
	);
}

/** 一个使用 demo-checks 节点包的场景文档：默认 Agent 为 agent，锁定 version。 */
export const scenarioUsing = (agent: string, version = "1.2.0") => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "ping", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "h" } },
	],
	edges: [{ from: "entry", to: "ping", kind: "chain" }],
	packages: { "demo-checks": version },
});

/**
 * 手动时钟走过 `ms`，期间 Agent 照常心跳：任务租约是 30 秒，不心跳的任务会以 agent_lost 失败，
 * 想让任务「执行了一分半钟」就不能一步推进。
 */
export async function elapseWithHeartbeats(
	clock: ManualClock,
	agents: readonly FakeAgent[],
	ms: number,
): Promise<void> {
	for (let left = ms; left > 0; left -= 20_000) {
		clock.advance(Math.min(left, 20_000));
		for (const agent of agents) await agent.heartbeat();
	}
}

/**
 * 让浏览器对某个 /api 接口的请求挂起，直到调用返回的 release()；用来观察加载状态。
 * 也可以传 fail 让它返回错误响应（错误状态）。
 */
export async function holdApi(page: Page, path: string) {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api${path}`, async (route) => {
		await released;
		await route.continue();
	});
	return { release };
}

/** 让浏览器对某个 /api 接口的请求返回控制面错误；返回的 restore() 之后恢复正常。 */
export async function failApi(page: Page, path: string, status = 503) {
	const handler = (route: import("@playwright/test").Route) =>
		route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "unavailable", message: "控制面暂时不可用" } }),
		});
	await page.route(`**/api${path}`, handler);
	return { restore: () => page.unroute(`**/api${path}`, handler) };
}

/**
 * 主链 entry → spawn → probe，子流程 sub → verify（都用 demo-checks/ping）。
 * 给了 `names` 时，probe 有显示名称、子流程有名称（没有名称的子流程以节点 ID 作名称）。
 */
export const withSubflow = (agent: string, names?: { probe: string; subflow: string }) => {
	const ping = (id: string, displayName?: string) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: "h" },
		...(displayName ? { display_name: displayName } : {}),
	});
	return {
		default_agent: agent,
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "spawn", kind: "async", params: {} },
			ping("probe", names?.probe),
			{ id: "sub", kind: "subflow_entry", ...(names ? { name: names.subflow } : {}) },
			ping("verify"),
		],
		edges: [
			{ from: "entry", to: "spawn", kind: "chain" },
			{ from: "spawn", to: "probe", kind: "chain" },
			{ from: "sub", to: "verify", kind: "chain" },
			{ from: "spawn", to: "sub", kind: "dispatch" },
		],
		packages: { "demo-checks": "1.2.0" },
	};
};

/**
 * 断言焦点在 locator 上，并且焦点环可见（docs/DESIGN-SYSTEM.md §7：`:focus-visible` 时 2px 青色外框，
 * 容器不能用 outline-none 去掉它）。
 */
export async function expectFocusVisible(locator: Locator): Promise<void> {
	await expect(locator).toBeFocused();
	const ring = await locator.evaluate((el) => {
		const style = getComputedStyle(el);
		return {
			focusVisible: el.matches(":focus-visible"),
			outline: `${style.outlineStyle} ${style.outlineWidth}`,
		};
	});
	expect(ring).toEqual({ focusVisible: true, outline: "solid 2px" });
}

/**
 * 断言屏幕上 (x, y) 这一像素是焦点环的颜色（`--ring`）：计算样式里有轮廓，不等于它没被上面的元素盖住。
 */
export async function expectRingPainted(page: Page, at: { x: number; y: number }): Promise<void> {
	const png = await page.screenshot({ clip: { ...at, width: 1, height: 1 } });
	const colors = await page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) throw new Error("没有 2D canvas");
		ctx.drawImage(img, 0, 0);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		const probe = document.createElement("i");
		probe.style.color = "var(--ring)";
		document.body.append(probe);
		const ring = getComputedStyle(probe).color;
		probe.remove();
		return { pixel: `rgb(${r}, ${g}, ${b})`, ring };
	}, png.toString("base64"));
	expect(colors.pixel).toBe(colors.ring);
}

/** 屏幕上 (x, y) 这一像素实际画出来的颜色（sRGB，0–255）：叠在一起的几层都算进去。 */
export async function screenPixel(page: Page, at: { x: number; y: number }): Promise<number[]> {
	const png = await page.screenshot({
		clip: { x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 },
	});
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) throw new Error("没有 2D canvas");
		ctx.drawImage(img, 0, 0);
		return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
	}, png.toString("base64"));
}

/** 元素在页面上的位置和大小；不可见时报错。 */
export async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error("元素不可见");
	return b;
}

type Rect = { x: number; y: number; width: number; height: number };

/** 两个矩形有没有重叠。 */
export const overlap = (a: Rect, b: Rect) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
