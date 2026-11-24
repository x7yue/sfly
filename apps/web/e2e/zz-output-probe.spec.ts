import { expect, test } from "./fixtures";
import { metricPackage, openMonitor } from "./monitor-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";

// 一次性的量数探针（不提交）：节点的输出里有 3000 个字符串，打开「输入输出」页签：DOM 节点数和出现全部内容的时间。
test("PROBE output 3000 strings", async ({ page, controlPlane, connectAgent, clock }) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "输出面板", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "probe", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const probe = await agent.nextAssign({ start: false });
	clock.advance(2000);
	await agent.started(probe);
	const items = Array.from({ length: 3000 }, (_, i) => `订单 ${i}：已处理 worker-${i % 17} 耗时 ${i % 97}ms`);
	await agent.succeed(probe, { items });
	clock.advance(1000);

	const times: number[] = [];
	let nodes = 0;
	for (let round = 0; round < 5; round++) {
		await openMonitor(page, clock, runId, "probe", "attempts");
		await expect(page.getByRole("region", { name: "底部面板" })).toBeVisible();
		const io = page.getByRole("tab", { name: /输入输出/ });
		const t0 = Date.now();
		await io.click();
		await page.waitForFunction(() => document.body.textContent?.includes("订单 2999：已处理") ?? false, null, { timeout: 30_000 });
		times.push(Date.now() - t0);
		nodes = await page.getByRole("region", { name: "底部面板" }).evaluate((el) => el.querySelectorAll("*").length);
	}
	times.sort((a, b) => a - b);
	console.log(`PROBE-OUT nodes=${nodes} median=${times[2]}ms all=${times.join(",")}`);
});
