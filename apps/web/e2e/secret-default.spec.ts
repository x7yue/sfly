import type { Page } from "@playwright/test";
import { orchestrationsApi } from "@sfly/schema";
import { actAs } from "../../server/test/support/credentials.js";
import { storedDocument } from "../../server/test/support/stored-document";
import type { TestControlPlane } from "../../server/test/support/test-control-plane";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, triggerRun } from "./support";

// 场景版本里 secret 参数的默认值（#467）：控制面读出来是占位符，画布显示成「已设置」，可以整个替换，读不回来；
// 不动它保存，新版本沿用原来的值；运行时节点仍然收到原值。

const SECRET = "test-secret-value";

/** 入口参数 api_token（secret，有默认值）和 region；api_token 传给节点的 host 输入，Agent 收到的就是它的值。 */
const SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [
				{ name: "api_token", type: "string", secret: true, default: SECRET },
				{ name: "region", type: "string", default: "cn-east" },
			],
		},
		{
			id: "ping",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 300, y: 0 },
			inputs: { host: "${{ params.api_token }}" },
		},
	],
	edges: [{ from: "entry", to: "ping", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

const tokenParam = (page: Page) => inspector(page).getByRole("group", { name: "参数 api_token" });
const regionParam = (page: Page) => inspector(page).getByRole("group", { name: "参数 region" });

async function openScenario(page: Page, controlPlane: TestControlPlane): Promise<string> {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "secret 默认值", SCENARIO);
	await openEditor(page, id, "ping");
	await nodeCard(page, "entry").click();
	return id;
}

const head = async (controlPlane: TestControlPlane, id: string) =>
	orchestrationsApi.head.response.parse(
		await (await controlPlane.fetch(`/orchestrations/${id}/head`)).json(),
	);

const defaultsOf = async (controlPlane: TestControlPlane, id: string, number?: number) => {
	const entry = (await storedDocument(controlPlane, id, number)).nodes.find(
		(n) => n.id === "entry",
	);
	return entry?.kind === "entry" ? entry.params.map((p) => [p.name, p.default]) : [];
};

test("打开画布：secret 参数的默认值显示成「已设置」，页面里没有原值；改别的字段、保存，原来的默认值不变，运行仍收到原值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	const id = await openScenario(page, controlPlane);
	const value = tokenParam(page).getByLabel("默认值", { exact: true });
	await expect(value).toHaveValue("已设置");
	await expect(value).toHaveAttribute("readonly", "");
	await expect(tokenParam(page).getByRole("button", { name: "临时显示默认值" })).toHaveCount(0);
	await expect(page.locator("body")).not.toContainText(SECRET);
	expect(await page.content()).not.toContain(SECRET);

	// 改别的字段（普通参数的默认值）再保存。
	await regionParam(page).getByRole("combobox", { name: "默认值" }).fill("cn-west");
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	// 保存时提醒：secret 参数写了默认值，会留在这个版本里。
	await expect(page.getByText("1 个 secret 参数写了默认值")).toBeVisible();

	// 读出来仍是占位符；库里存的还是原值，普通参数的新默认值保存下来了。
	const saved = await head(controlPlane, id);
	expect(JSON.stringify(saved)).not.toContain(SECRET);
	expect(await defaultsOf(controlPlane, id)).toEqual([
		["api_token", SECRET],
		["region", "cn-west"],
	]);
	await expect(value).toHaveValue("已设置");

	// 运行：节点收到的是原值。
	await triggerRun(controlPlane, id);
	expect((await agent.nextAssign()).inputs).toMatchObject({ host: SECRET });
});

test("点「替换」输入新的值：新值保存下来，读出来仍是占位符，运行收到新值；输入 ****** 本身不允许", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	const id = await openScenario(page, controlPlane);
	await tokenParam(page).getByRole("button", { name: "替换 api_token 的默认值" }).click();
	const value = tokenParam(page).getByLabel("默认值", { exact: true });
	await expect(value).toHaveValue("");
	await expect(value).toHaveAttribute("type", "password");

	// ****** 是「已设置」的占位符，不能当成新的默认值（保存时会被当成沿用原值）。
	await value.fill("******");
	await value.blur();
	await expect(tokenParam(page).getByText("不能是 ******")).toBeVisible();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toHaveCount(0);

	await value.fill("test-secret-replaced");
	await tokenParam(page).getByRole("button", { name: "临时显示默认值" }).click();
	await expect(value).toHaveAttribute("type", "text");
	await expect(value).toHaveValue("test-secret-replaced");
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();

	expect(await defaultsOf(controlPlane, id)).toEqual([
		["api_token", "test-secret-replaced"],
		["region", "cn-east"],
	]);
	expect(JSON.stringify(await head(controlPlane, id))).not.toContain("test-secret-replaced");
	await triggerRun(controlPlane, id);
	expect((await agent.nextAssign()).inputs).toMatchObject({ host: "test-secret-replaced" });
});

test("取消「secret」：已设置的默认值读不回来，随标记一起清空，不会把占位符或原值带到普通参数上", async ({
	page,
	controlPlane,
}) => {
	const id = await openScenario(page, controlPlane);
	await tokenParam(page).getByRole("switch", { name: "secret" }).click();
	const confirm = page.getByRole("dialog", { name: "取消参数 api_token 的「secret」标记？" });
	await expect(confirm).toContainText("已设置的默认值读不回来，取消后会被清空");
	await confirm.getByRole("button", { name: "取消 secret 标记" }).click();
	// 不再是 secret：普通的输入框，默认值是空的（显示的是占位提示）。
	await expect(tokenParam(page).getByRole("combobox", { name: "默认值" })).toHaveText(
		"默认值（可选）",
	);
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	expect(await defaultsOf(controlPlane, id)).toEqual([
		["api_token", undefined],
		["region", "cn-east"],
	]);
	expect(JSON.stringify(await storedDocument(controlPlane, id))).not.toContain(SECRET);
	expect(JSON.stringify(await storedDocument(controlPlane, id))).not.toContain("******");
});

test("保存冲突后「另存为新场景」：已设置的 secret 默认值带不过去，提示写明，新场景里没有它", async ({
	page,
	controlPlane,
}) => {
	const id = await openScenario(page, controlPlane);
	// 本地改一点，别人先保存了新版本。
	await regionParam(page).getByRole("combobox", { name: "默认值" }).fill("cn-west");
	await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("bob") },
		body: JSON.stringify({ base_version: 1, document: { ...SCENARIO, default_agent: "agent-b" } }),
	});
	await page.keyboard.press("Control+s");
	const dialog = page.getByRole("dialog", { name: "保存被拦截：场景已有更新的版本" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("已设置的 secret 默认值（1 个）读不回来");
	await dialog.getByRole("button", { name: "另存为新场景" }).click();
	await expect(page).not.toHaveURL(new RegExp(id));
	const copyId = page.url().split("/").at(-1) as string;
	expect(copyId).toMatch(/^[0-9a-f-]{36}$/);
	expect(await defaultsOf(controlPlane, copyId)).toEqual([
		["api_token", undefined],
		["region", "cn-west"],
	]);
});
