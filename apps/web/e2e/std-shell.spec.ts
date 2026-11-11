// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import shellNode from "../../../testdata/std-shell-node.json" with { type: "json" };
import { nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 标准节点 shell 的输出在编排画布上的展示（#181）。节点类型取自构建出的 sfly-std
// （testdata/std-shell-node.json，std/tests/test_package.py 保证它与 `sfly build std` 的结果一致）：
// 这里运行在没有 Python 的 Playwright 镜像里，构建不了 sfly-std。

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
				position: { x: 252, y: 0 },
				inputs: { command: "make dist" },
			},
			{
				id: "check",
				kind: "package",
				package: "sfly-std",
				node: "shell",
				position: { x: 504, y: 0 },
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
	const listed = panel.getByRole("definition").filter({ hasText: "exit_code" });
	await expect
		.poll(async () => ((await listed.textContent()) ?? "").split(" · ").sort())
		.toEqual(["exit_code", "stderr", "stderr_file", "stdout", "stdout_file"]);

	// check.command 引用了 build 的输出：清空后输入 $，补全列出 build 的全部输出。
	await nodeCard(page, "check").click();
	await panel.getByRole("tab", { name: "参数" }).click();
	const command = panel.getByRole("combobox", { name: "输入 command" });
	await expect(command).toHaveText("${{ nodes.build.outputs.stdout }}");
	await command.fill("");
	await page.keyboard.type("$");
	const outputs = panel
		.getByRole("listbox", { name: "可引用的值" })
		.getByRole("group", { name: "前序节点" })
		.getByRole("option");
	await expect(outputs).toHaveCount(5);
	for (const option of [
		/^nodes\.build\.outputs\.exit_code\s*integer · build$/,
		/^nodes\.build\.outputs\.stdout\s*string · build$/,
		/^nodes\.build\.outputs\.stderr\s*string · build$/,
		/^nodes\.build\.outputs\.stdout_file\s*build$/,
		/^nodes\.build\.outputs\.stderr_file\s*build$/,
	]) {
		await expect(outputs.filter({ hasText: option })).toHaveCount(1);
	}
	// 由 $ 弹出的补全没有预选项：先用方向键选中唯一的匹配，再按 Enter 插入。
	await page.keyboard.type("stderr_f");
	await expect(outputs).toHaveCount(1);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(command).toHaveText("${{ nodes.build.outputs.stderr_file }}");
});
