import type { JSHandle, Page } from "@playwright/test";
import { expect, test } from "./cross-origin-fixtures";
import { openPage } from "./cross-origin-page";
import { START_TIME } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing } from "./support";

const NICKNAME = "小明";

interface Subscription {
	statuses: string[];
	stop: () => void;
}

function subscribeToRun(
	page: Page,
	baseUrl: string,
	runId: string,
): Promise<JSHandle<Subscription>> {
	return page.evaluateHandle(
		({ baseUrl, runId }) => {
			const statuses: string[] = [];
			const client = window.sfly.createClient({ baseUrl });
			const stop = client.runs.events(
				{ params: { id: runId } },
				{ run: (view) => statuses.push(view.status) },
			);
			return { statuses, stop };
		},
		{ baseUrl, runId },
	);
}

const latestStatus = (subscription: JSHandle<Subscription>) =>
	subscription.evaluate(({ statuses }) => statuses.at(-1));

function readThenTrigger(page: Page, baseUrl: string, scenarioId: string) {
	return page.evaluate(
		async ({ baseUrl, scenarioId, nickname }) => {
			const client = window.sfly.createClient({ baseUrl, nickname });
			const { orchestrations } = await client.orchestrations.list();
			const run = await client.runs.trigger({ params: { id: scenarioId } });
			return { scenarios: orchestrations.map((s) => s.name), runId: run.id };
		},
		{ baseUrl, scenarioId, nickname: NICKNAME },
	);
}

test("另一个来源的页面：读到场景列表，带昵称触发运行（浏览器先预检），订阅运行的事件流并收到事件", async ({
	page,
	pageHost,
	controlPlane,
	controlPlaneProxy,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	await openPage(page, pageHost);

	const { scenarios, runId } = await readThenTrigger(page, controlPlaneProxy.url, scenarioId);

	expect(scenarios).toEqual(["巡检"]);
	const triggers = controlPlaneProxy.requests.filter(
		(request) => request.path === `/orchestrations/${scenarioId}/runs`,
	);
	expect(triggers.map((request) => request.method)).toEqual(["OPTIONS", "POST"]);
	const [preflight, post] = triggers;
	expect(preflight?.headers.origin).toBe(pageHost.origin);
	expect(preflight?.headers["access-control-request-method"]).toBe("POST");
	expect(preflight?.headers["access-control-request-headers"]).toContain("x-sfly-nickname");
	expect(post?.headers["x-sfly-nickname"]).toBe(encodeURIComponent(NICKNAME));

	const subscription = await subscribeToRun(page, controlPlaneProxy.url, runId);
	await expect.poll(() => latestStatus(subscription)).toBe("running");
	await agent.succeed(await agent.nextAssign());
	await expect.poll(() => latestStatus(subscription)).toBe("success");
	await subscription.evaluate(({ stop }) => stop());
});

test.describe("控制面版本和 API 客户端不一致", () => {
	test.use({ controlPlaneVersion: "9.9.9" });

	test("页面读得到 x-sfly-version 和 x-sfly-time：版本不一致的警告出现一次，时间回调收到控制面的时间", async ({
		page,
		pageHost,
		controlPlane,
		clock,
	}) => {
		const warnings: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "warning") warnings.push(message.text());
		});
		await openPage(page, pageHost);
		const session = await page.evaluateHandle((baseUrl) => {
			const times: string[] = [];
			const client = window.sfly.createClient({
				baseUrl,
				onControlPlaneTime: (time) => times.push(time),
			});
			return { client, times, clientVersion: window.sfly.CLIENT_VERSION };
		}, controlPlane.httpUrl);

		await session.evaluate(({ client }) => client.dashboard.get());
		clock.advance(60_000);
		await session.evaluate(({ client }) => client.dashboard.get());

		expect(await session.evaluate(({ times }) => times)).toEqual([
			START_TIME,
			new Date(Date.parse(START_TIME) + 60_000).toISOString(),
		]);
		const clientVersion = await session.evaluate((s) => s.clientVersion);
		await expect.poll(() => warnings).toHaveLength(1);
		expect(warnings[0]).toContain("9.9.9");
		expect(warnings[0]).toContain(clientVersion);
	});
});

test.describe("SFLY_CORS_ORIGINS 设置了来源名单", () => {
	test.use({ restrictCorsToPage: true });

	test("名单里的来源照常调用：读、带昵称触发、订阅事件流", async ({
		page,
		pageHost,
		controlPlane,
		connectAgent,
	}) => {
		const agent = await connectAgent({ name: "agent", slots: 4 });
		await publishPackage(controlPlane);
		const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
		await openPage(page, pageHost);

		const { scenarios, runId } = await readThenTrigger(page, controlPlane.httpUrl, scenarioId);
		const subscription = await subscribeToRun(page, controlPlane.httpUrl, runId);
		await agent.succeed(await agent.nextAssign());

		expect(scenarios).toEqual(["巡检"]);
		await expect.poll(() => latestStatus(subscription)).toBe("success");
		await subscription.evaluate(({ stop }) => stop());
	});

	test("名单外的来源：请求被浏览器拦下，读不到数据，触发的请求没有发到控制面", async ({
		page,
		foreignPageHost,
		controlPlane,
	}) => {
		const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
		const blocked: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error" && message.text().includes("blocked by CORS policy")) {
				blocked.push(message.text());
			}
		});
		await openPage(page, foreignPageHost);

		const codes = await page.evaluate(
			async ({ baseUrl, scenarioId, nickname }) => {
				const client = window.sfly.createClient({ baseUrl, nickname });
				const codeOf = (call: () => Promise<unknown>) =>
					call().then(
						() => "ok",
						(error: { code: string }) => error.code,
					);
				return {
					read: await codeOf(() => client.orchestrations.list()),
					write: await codeOf(() => client.runs.trigger({ params: { id: scenarioId } })),
				};
			},
			{ baseUrl: controlPlane.httpUrl, scenarioId, nickname: NICKNAME },
		);

		expect(codes).toEqual({ read: "network_error", write: "network_error" });
		await expect.poll(() => blocked.length).toBeGreaterThanOrEqual(2);
		const { runs } = (await (await controlPlane.fetch("/runs")).json()) as { runs: unknown[] };
		expect(runs).toEqual([]);
	});

	test("控制台自己（同源）不受名单影响：名单里没有控制台的来源，页面照常读取并触发运行", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		const agent = await connectAgent({ name: "agent", slots: 4 });
		await publishPackage(controlPlane);
		await createScenario(controlPlane, "巡检", scenarioUsing("agent"));

		await page.goto("/orchestrations");
		await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
		const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
		await expect(drawer.getByRole("list", { name: "触发前检查" })).toContainText(
			"结构与引用检查通过",
		);
		await drawer.getByRole("button", { name: "触发运行" }).click();

		await agent.succeed(await agent.nextAssign());
		await expect(drawer.getByRole("region", { name: "运行摘要" })).toContainText("tester 触发");
	});
});
