// sfly-platform skill「编辑场景」里加一步的例子（#472，#470 改成 scenario edit）：AI 编程助手照它改场景。
// 把例子里的占位换成真实的值，真实的 sfly 进程照着执行：--dry-run 不产生版本，去掉 --dry-run 存成新版本，都没有警告。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** skill「编辑场景」一节里的例子：这一节唯一的 sh 代码块，一条 `uv run sfly scenario edit` 命令。 */
async function skillExample(): Promise<string> {
	const skill = await readFile(join(repoRoot, "docs/guide/skills/sfly-platform/SKILL.md"), "utf8");
	const section = /^## 编辑场景\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
	const blocks = [...section.matchAll(/^ *```sh\n([\s\S]*?)^ *```$/gm)].map((m) => m[1] ?? "");
	expect(blocks, "「编辑场景」一节要有且只有一个 sh 例子").toHaveLength(1);
	return (blocks[0] ?? "").trim();
}

/** 按 shell 的规则把命令切成参数（例子里只有双引号）。 */
const words = (line: string): string[] =>
	[...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");

describe("sfly-platform skill「编辑场景」的例子 → sfly scenario edit", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const cli = (args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "probe-kit", "1.0.0", {
			wait_ready: {
				outputs: [],
				inputs: { properties: { base_url: { type: "string" } }, required: ["base_url"] },
			},
			check: {
				outputs: [],
				inputs: { properties: { base_url: { type: "string" } }, required: ["base_url"] },
			},
		});
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
	});

	it("例子是一条 scenario edit add：接在前一个节点后面、写了显示名称和输入、先 --dry-run", async () => {
		const args = words(await skillExample());
		expect(args.slice(0, 6)).toEqual(["uv", "run", "sfly", "scenario", "edit", "<场景>"]);
		expect(args).toContain("add");
		for (const flag of ["--after", "--display-name", "--input", "--dry-run"]) {
			expect(args, flag).toContain(flag);
		}
	});

	it("替换占位后执行：--dry-run 不产生版本，去掉 --dry-run 存成新版本，都没有警告", async () => {
		const id = await api.orchestrationWith(
			{
				default_agent: "agent-a",
				nodes: [
					{
						id: "entry",
						kind: "entry",
						display_name: "开始",
						params: [{ name: "base_url", type: "string", default: "http://sut:9000" }],
					},
					{
						id: "wait_ready",
						kind: "package",
						package: "probe-kit",
						node: "wait_ready",
						display_name: "等服务就绪",
						inputs: { base_url: "${{ params.base_url }}" },
					},
				],
				edges: [{ from: "entry", to: "wait_ready", kind: "chain" }],
				packages: { "probe-kit": "1.0.0" },
			},
			"编辑场景的例子",
		);
		const filled = (await skillExample())
			.replaceAll("<场景>", id)
			.replaceAll("<包名>", "probe-kit")
			.replaceAll("<节点名>", "check")
			.replaceAll("<前一个节点 id>", "wait_ready")
			.replaceAll("<说明它做什么的显示名称>", "检查商品列表")
			.replaceAll("<输入名>", "base_url")
			.replaceAll("<值>", "http://sut:9000");
		expect(filled, "例子里还有没替换的占位").not.toMatch(/<[^>]+>/);
		const args = words(filled).slice(2); // 去掉 uv run

		const dry = await cli([...args.slice(1), "--json"]);
		expect(dry.code, dry.stderr).toBe(0);
		expect(JSON.parse(dry.stdout)).toMatchObject({ saved: false, warnings: [] });
		expect(await api.headVersion(id)).toBe(1);

		const saved = await cli([...args.slice(1).filter((a) => a !== "--dry-run"), "--json"]);
		expect(saved.code, saved.stderr).toBe(0);
		expect(JSON.parse(saved.stdout)).toMatchObject({ saved: true, version: 2, warnings: [] });
	});
});
