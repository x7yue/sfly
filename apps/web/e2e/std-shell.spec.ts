// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import shellNode from "../../../testdata/std-shell-node.json" with { type: "json" };
import { nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 标准节点 shell 的输出在编排画布上的展示（#181）。节点类型取自构建出的 sfly-std
// （testdata/std-shell-node.json，std/tests/test_package.py 保证它与 `sfly build std` 的结果一致）：
// 这里运行在没有 Python 的 Playwright 镜像里，构建不了 sfly-std。
// 输出的说明就是代码里 Doc 写的（#317），检查器和引用补全显示的文字取自这份副本。

const outputs = shellNode.outputs.properties;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("Shell 命令节点的输出出现在检查器的输出列表里，后续节点引用补全能选到它们", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { name: "sfly-std", version: "0.3.0", nodes: [shellNode] });
	const id = await createScenario(controlPlane, "构建后检查", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
			{
				id: "build",
				kind: "package",
				package: "sfly-std",
				node: "shell",
				position: { x: 300, y: 0 },
				inputs: { command: "make dist" },
			},
			{
				id: "check",
				kind: "package",
				package: "sfly-std",
				node: "shell",
				position: { x: 600, y: 0 },
				inputs: { command: "${{ nodes.build.outputs.stdout }}" },
			},
		],
		edges: [
			{ from: "entry", to: "build", kind: "chain" },
			{ from: "build", to: "check", kind: "chain" },
		],
		packages: { "sfly-std": "0.3.0" },
	});
	await page.goto(`/orchestrations/${id}`);
	const panel = page.getByRole("complementary", { name: "检查器" });

	await nodeCard(page, "build").click();
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	// 输出的先后不是声明的顺序（节点类型存进数据库后键的顺序不保留），这里只看有哪些。
	const listed = panel.getByRole("table", { name: "输出" }).locator("tbody td:first-child");
	await expect
		.poll(async () => (await listed.allTextContents()).sort())
		.toEqual(["exit_code", "stderr", "stderr_file", "stdout", "stdout_file"]);
	const documented = panel.getByRole("table", { name: "输出" }).locator("tbody td:nth-child(2)");
	await expect
		.poll(async () => (await documented.allTextContents()).sort())
		.toEqual(
			Object.values(outputs)
				.map((output) => output.description)
				.sort(),
		);

	// check.command 引用了 build 的输出：清空后输入 $，补全列出 build 的全部输出。
	await nodeCard(page, "check").click();
	await panel.getByRole("tab", { name: "参数" }).click();
	const command = panel.getByRole("combobox", { name: "输入 command" });
	await expect(command).toHaveText("${{ nodes.build.outputs.stdout }}");
	await command.fill("");
	await page.keyboard.type("$");
	const options = panel
		.getByRole("listbox", { name: "可引用的值" })
		.getByRole("group", { name: "前序节点" })
		.getByRole("option");
	await expect(options).toHaveCount(5);
	for (const [name, type] of [
		["exit_code", "integer · "],
		["stdout", "string · "],
		["stderr", "string · "],
		["stdout_file", ""],
		["stderr_file", ""],
	] as const) {
		const option = new RegExp(
			`^nodes\\.build\\.outputs\\.${name}\\s*${type}build\\s*${escaped(outputs[name].description)}$`,
		);
		await expect(options.filter({ hasText: option })).toHaveCount(1);
	}
	// 由 $ 弹出的补全没有预选项：先用方向键选中唯一的匹配，再按 Enter 插入。
	await page.keyboard.type("stderr_f");
	await expect(options).toHaveCount(1);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(command).toHaveText("${{ nodes.build.outputs.stderr_file }}");
});
