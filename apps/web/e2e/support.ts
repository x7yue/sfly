import { expect, type Locator, type Page } from "@playwright/test";
import { ErrorKind } from "../../server/test/support/fake-agent.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
} from "../../server/test/support/package-archive.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";

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

/** 主链 entry → spawn → probe，子流程 sub → verify（都用 demo-checks/ping）。 */
const withSubflow = (agent: string) => {
	const ping = (id: string) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: "h" },
	});
	return {
		default_agent: agent,
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "spawn", kind: "async", params: {} },
			ping("probe"),
			{ id: "sub", kind: "subflow_entry" },
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
 * 固定的一组数据（手动时钟从 2026-01-01T00:00Z，即浏览器里的 08:00 开始）：
 * 巡检成功一次、超时失败一次；一小时后撮合压测开始运行，子流程的 verify 失败、主链的 probe 仍在执行。
 * agent-mac 离线。返回撮合压测的运行 ID。
 */
export async function seedDashboard({
	page,
	controlPlane,
	connectAgent,
	clock,
}: Pick<E2eFixtures, "controlPlane" | "connectAgent" | "clock"> & { page: Page }) {
	const linux = await connectAgent({
		name: "agent-linux",
		os: "linux",
		arch: "x86_64",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const mac = await connectAgent({ name: "agent-mac", slots: 2 });
	await mac.disconnect();
	await publishPackage(controlPlane);
	const inspect = await createScenario(controlPlane, "巡检", scenarioUsing("agent-linux"));
	const stress = await createScenario(controlPlane, "撮合压测", withSubflow("agent-linux"));

	await triggerRun(controlPlane, inspect);
	await linux.succeed(await linux.nextAssign());
	clock.advance(60_000);
	const failed = await triggerRun(controlPlane, inspect);
	await linux.fail(await linux.nextAssign(), "等待响应超时", ErrorKind.TIMEOUT);

	clock.advance(3_600_000);
	const running = await triggerRun(controlPlane, stress);
	const first = await linux.nextAssign();
	const second = await linux.nextAssign();
	await linux.fail(first.nodeId === "verify" ? first : second, "校验失败");
	// 不超过任务租约（30 秒），probe 保持执行中。
	clock.advance(15_000);
	await page.clock.setFixedTime(clock.now());
	return { linux, running, failed };
}

/**
 * 断言焦点在 locator 上，并且焦点环可见（DESIGN-SYSTEM §7：`:focus-visible` 时 2px 青色外框，
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
