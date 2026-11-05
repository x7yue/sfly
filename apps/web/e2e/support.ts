import type { Page } from "@playwright/test";
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
	await ok(await cp.fetch("/packages", publishInit(archive)), "发布节点包");
}

/** 新建场景，给了文档时保存为第 1 版；返回场景 ID。 */
export async function createScenario(
	cp: TestControlPlane,
	name: string,
	document?: Record<string, unknown>,
): Promise<string> {
	const json = (body: unknown): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
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
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ params: {} }),
		}),
		"触发运行",
	);
	return ((await res.json()) as { id: string }).id;
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
