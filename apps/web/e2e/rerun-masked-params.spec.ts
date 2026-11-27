import { actAs } from "../../server/test/support/credentials.js";
import { expect, test } from "./fixtures";
import { metricPackage, openMonitor } from "./monitor-scenario";
import { createScenario, publishPackage } from "./support";

// 「再次运行」不预填值里含有 secret 值的普通参数（#485）：运行视图给的是打码后的值，原样预填、不改就触发，节点拿到的是掩码。

const SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "region", type: "string", default: "cn-east" },
				{ name: "url", type: "string", default: "https://example.test/" },
				{ name: "token", type: "string", default: "s3cr3t-token", secret: true },
			],
		},
		{
			id: "fetch",
			kind: "package",
			package: "demo-checks",
			node: "http_check",
			inputs: { url: "${{ params.url }}", token: "${{ params.token }}" },
		},
	],
	edges: [{ from: "entry", to: "fetch", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

test("再次运行：值里含有 secret 值的参数不预填、写明原因，重新填写后节点收到新值；其余参数照常预填", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "带令牌的地址", SCENARIO);
	const res = await controlPlane.fetch(`/orchestrations/${scenarioId}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify({
			params: { region: "eu-west", url: "https://example.test/?token=s3cr3t-token" },
		}),
	});
	expect(res.ok).toBe(true);
	const runId = ((await res.json()) as { id: string }).id;
	const first = await agent.nextAssign();
	expect(first.inputs.url).toBe("https://example.test/?token=s3cr3t-token");
	clock.advance(1000);
	await agent.succeed(first, { status: 200 });

	await openMonitor(page, clock, runId);
	await page.getByRole("banner").getByRole("button", { name: "再次运行" }).click();
	const rerun = page.getByRole("dialog", { name: "再次运行 · 带令牌的地址" });
	await expect(rerun.getByRole("textbox", { name: /^region/ })).toHaveValue("eu-west");
	const url = rerun.getByRole("textbox", { name: /^url/ });
	await expect(url).toHaveValue("https://example.test/");
	await expect(url).toHaveAccessibleDescription(/上一次的值里含有 secret 值，读不回来，请重新填写/);
	await expect(rerun).not.toContainText("******");

	await url.fill("https://example.test/?token=new-token");
	await rerun.getByRole("button", { name: "触发运行" }).click();
	await expect(rerun).toHaveCount(0);
	const second = await agent.nextAssign();
	expect(second.inputs).toMatchObject({
		url: "https://example.test/?token=new-token",
		token: "s3cr3t-token",
	});
});
