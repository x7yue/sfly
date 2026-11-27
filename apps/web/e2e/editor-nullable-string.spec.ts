import { headOf, inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 「字符串或 null」（str | None）的输入按文本填，不用加引号写成 JSON（#404 第 6 条）。

const STRING_OR_NULL = { anyOf: [{ type: "string" }, { type: "null" }] };

const nodes = [
	{
		name: "start",
		title: "启动服务",
		entry: "demo_checks.svc:start",
		inputs: {
			type: "object",
			properties: {
				cwd: { ...STRING_OR_NULL, default: null },
				log_file: STRING_OR_NULL,
			},
			required: ["log_file"],
		},
		outputs: { type: "object", properties: {} },
	},
];

const document = {
	default_agent: "agent-linux",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
		{
			id: "start",
			kind: "package",
			package: "demo-checks",
			node: "start",
			position: { x: 300, y: 0 },
			inputs: { log_file: "/tmp/old.log" },
		},
	],
	edges: [{ from: "entry", to: "start", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

test("字符串或 null 的输入直接填文本、不报 JSON 错误；可选的留空是不填，必填的留空写 null", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes });
	const id = await createScenario(controlPlane, "启动被测服务", document);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "start").click();
	const panel = inspector(page);

	const cwd = panel.getByRole("combobox", { name: "输入 cwd" });
	await cwd.fill("/var/log/demo-svc");
	await cwd.blur();
	await expect(panel.getByText("不是合法的 JSON")).toHaveCount(0);

	const logFile = panel.getByRole("combobox", { name: "输入 log_file" });
	await expect(logFile).toHaveText("/tmp/old.log");
	await logFile.fill("");
	await logFile.blur();

	await page.getByRole("button", { name: /^保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "start")?.inputs,
	).toEqual({ cwd: "/var/log/demo-svc", log_file: null });

	await cwd.fill("");
	await cwd.blur();
	await page.getByRole("button", { name: /^保存/ }).click();
	await expect(page.getByText("已保存为版本 3")).toBeVisible();
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "start")?.inputs,
	).toEqual({ log_file: null });
});
