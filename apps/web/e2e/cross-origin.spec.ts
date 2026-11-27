import type { JSHandle, Page } from "@playwright/test";
import { expect, test } from "./cross-origin-fixtures";
import { openPage } from "./cross-origin-page";
import { START_TIME } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing } from "./support";

/** 另一个来源的页面用这个人的个人令牌调用（测试用户的显示名就是这个名字）。 */
const TRIGGERER = "小明";

interface Subscription {
	statuses: string[];
	stop: () => void;
}

function subscribeToRun(
	page: Page,
	baseUrl: string,
	runId: string,
	token: string,
): Promise<JSHandle<Subscription>> {
	return page.evaluateHandle(
		({ baseUrl, runId, token }) => {
			const statuses: string[] = [];
			const client = window.sfly.createClient({ baseUrl, token });
			const stop = client.runs.events(
				{ params: { id: runId } },
				{ run: (view) => statuses.push(view.status) },
			);
			return { statuses, stop };
		},
		{ baseUrl, runId, token },
	);
}

const latestStatus = (subscription: JSHandle<Subscription>) =>
	subscription.evaluate(({ statuses }) => statuses.at(-1));

function readThenTrigger(page: Page, baseUrl: string, scenarioId: string, token: string) {
	return page.evaluate(
		async ({ baseUrl, scenarioId, token }) => {
			const client = window.sfly.createClient({ baseUrl, token });
			const { orchestrations } = await client.orchestrations.list({
				params: { project: "default" },
			});
			const run = await client.runs.trigger({ params: { id: scenarioId } });
			return {
				scenarios: orchestrations.map((s) => s.name),
				runId: run.id,
				triggeredBy: run.triggered_by,
			};
		},
		{ baseUrl, scenarioId, token },
	);
}

test("另一个来源的页面：带个人令牌读到场景列表、触发运行（浏览器先预检，触发人是令牌的用户），订阅运行的事件流并收到事件", async ({
	page,
	pageHost,
	controlPlane,
	controlPlaneProxy,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const token = await controlPlane.users.token(TRIGGERER);
	await openPage(page, pageHost);

	const { scenarios, runId, triggeredBy } = await readThenTrigger(
		page,
		controlPlaneProxy.url,
		scenarioId,
		token,
	);

	expect(scenarios).toEqual(["巡检"]);
	expect(triggeredBy).toBe(TRIGGERER);
	const triggers = controlPlaneProxy.requests.filter(
		(request) => request.path === `/orchestrations/${scenarioId}/runs`,
	);
	expect(triggers.map((request) => request.method)).toEqual(["OPTIONS", "POST"]);
	const [preflight, post] = triggers;
	expect(preflight?.headers.origin).toBe(pageHost.origin);
	expect(preflight?.headers["access-control-request-method"]).toBe("POST");
	expect(preflight?.headers["access-control-request-headers"]).toContain("authorization");
	expect(post?.headers.authorization).toBe(`Bearer ${token}`);

	const subscription = await subscribeToRun(page, controlPlaneProxy.url, runId, token);
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
		const session = await page.evaluateHandle(
			({ baseUrl, token }) => {
				const times: string[] = [];
				const client = window.sfly.createClient({
					baseUrl,
					token,
					onControlPlaneTime: (time) => times.push(time),
				});
				return { client, times, clientVersion: window.sfly.CLIENT_VERSION };
			},
			{ baseUrl: controlPlane.httpUrl, token: await controlPlane.users.token() },
		);

		await session.evaluate(({ client }) =>
			client.dashboard.get({ params: { project: "default" } }),
		);
		clock.advance(60_000);
		await session.evaluate(({ client }) =>
			client.dashboard.get({ params: { project: "default" } }),
		);

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

	test("名单里的来源照常调用：带个人令牌读、触发、订阅事件流", async ({
		page,
		pageHost,
		controlPlane,
		connectAgent,
	}) => {
		const agent = await connectAgent({ name: "agent", slots: 4 });
		await publishPackage(controlPlane);
		const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
		const token = await controlPlane.users.token(TRIGGERER);
		await openPage(page, pageHost);

		const { scenarios, runId } = await readThenTrigger(
			page,
			controlPlane.httpUrl,
			scenarioId,
			token,
		);
		const subscription = await subscribeToRun(page, controlPlane.httpUrl, runId, token);
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
		const token = await controlPlane.users.token(TRIGGERER);
		await openPage(page, foreignPageHost);

		const codes = await page.evaluate(
			async ({ baseUrl, scenarioId, token }) => {
				const client = window.sfly.createClient({ baseUrl, token });
				const codeOf = (call: () => Promise<unknown>) =>
					call().then(
						() => "ok",
						(error: { code: string }) => error.code,
					);
				return {
					read: await codeOf(() => client.orchestrations.list({ params: { project: "default" } })),
					write: await codeOf(() => client.runs.trigger({ params: { id: scenarioId } })),
				};
			},
			{ baseUrl: controlPlane.httpUrl, scenarioId, token },
		);

		expect(codes).toEqual({ read: "network_error", write: "network_error" });
		await expect.poll(() => blocked.length).toBeGreaterThanOrEqual(2);
		const { runs } = (await (await controlPlane.fetch("/projects/default/runs")).json()) as {
			runs: unknown[];
		};
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
