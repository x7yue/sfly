import { expect, test } from "./fixtures";
import { createScenario, failApi, publishPackage, scenarioUsing } from "./support";

// 节点包管理页（原型 #/packages）：列表 + 详情。

test("列表 + 详情：版本、发布时间、sha256、被锁定的场景数、节点类型的输入与输出", async ({
	page,
	controlPlane,
	clock,
}) => {
	await publishPackage(controlPlane, { version: "1.2.0" });
	clock.advance(3_600_000);
	await publishPackage(controlPlane, {
		version: "1.3.0",
		nodes: [
			{
				name: "http_check",
				title: "HTTP 检查",
				entry: "demo_checks.http:http_check",
				inputs: {
					type: "object",
					properties: { url: { type: "string" }, method: { type: "string" } },
					required: ["url"],
					order: ["url", "method"],
				},
				outputs: {
					type: "object",
					properties: { status: {}, body: {} },
					order: ["status", "body"],
				},
			},
		],
	});
	await publishPackage(controlPlane, { name: "alpha-tools", version: "0.1.0" });
	await createScenario(controlPlane, "a", scenarioUsing("x", "1.2.0"));
	await createScenario(controlPlane, "b", scenarioUsing("x", "1.2.0"));

	await page.goto("/packages");
	const list = page.getByRole("navigation", { name: "节点包" });
	await expect(list.getByRole("link")).toHaveText([
		/alpha-tools\s*0\.1\.0/,
		/demo-checks\s*1\.3\.0/,
	]);
	await expect(list.getByRole("link", { name: /demo-checks/ })).toContainText("2 个场景");

	await list.getByRole("link", { name: /demo-checks/ }).click();
	await expect(page).toHaveURL(/\/packages\?name=demo-checks$/);
	const detail = page.getByRole("region", { name: "demo-checks 详情" });
	await expect(detail).toContainText("1.3.0 最新");
	await expect(detail).toContainText("发布于 01-01 09:00");
	await expect(detail).toContainText("未被锁定");
	await expect(detail.getByRole("table", { name: "节点类型" }).getByRole("row")).toHaveText([
		"节点类型输入输出声明的指标图表",
		"http_checkHTTP 检查url* · methodstatus · body——（平台自带图表）",
	]);
	const versions = detail.getByRole("table", { name: "版本" }).getByRole("row");
	await expect(versions.nth(1)).toContainText("1.3.0");
	await expect(versions.nth(1)).toContainText("未被锁定");
	await expect(versions.nth(2)).toContainText("01-01 08:00");
	await expect(versions.nth(2)).toContainText("被 2 个场景锁定");

	// 切换到旧版本：详情跟着换，链接可以分享。
	await detail.getByRole("link", { name: "1.2.0" }).click();
	await expect(page).toHaveURL(/\/packages\?name=demo-checks&version=1\.2\.0$/);
	await expect(detail).toContainText("被 2 个场景锁定");
	await expect(detail.getByRole("table", { name: "节点类型" }).getByRole("row")).toHaveText([
		"节点类型输入输出声明的指标图表",
		"http_checkHTTP 检查url* · expectstatus——（平台自带图表）",
		"pingpinghost*alive——（平台自带图表）",
	]);
	const sha = await detail.locator("dd").first().textContent();
	expect(sha).toMatch(/^[0-9a-f]{64}$/);

	await page.reload();
	await expect(detail.getByRole("link", { name: "1.2.0" })).toHaveAttribute("aria-current");
});

test("还没有节点包时显示空状态和发布命令", async ({ page }) => {
	await page.goto("/packages");
	const empty = page.getByRole("region", { name: "还没有发布节点包" });
	await expect(empty).toContainText("sfly build && sfly publish");
});

test("加载失败时显示错误，可以重试", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const outage = await failApi(page, "/packages");
	await page.goto("/packages");
	await expect(page.getByRole("alert")).toContainText("无法加载节点包");
	await outage.restore();
	await page.getByRole("button", { name: "重试" }).click();
	await expect(page.getByRole("navigation", { name: "节点包" })).toContainText("demo-checks");
});
