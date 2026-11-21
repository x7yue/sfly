// sfly-platform skill「编辑场景」里新加一个节点和一条连线的最小例子（#472）：AI 编程助手照它改场景。
// 把例子拼进一份场景文档，真实的 sfly 进程 scenario push 到测试控制面：过本地和服务端的校验，不产生警告。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Fragment {
	nodes: Array<Record<string, unknown>>;
	edges: Array<{ from: string; to: string; kind: string }>;
}

/** skill「编辑场景」一节里的例子：这一节唯一的 json 代码块。 */
async function skillExample(): Promise<string> {
	const skill = await readFile(join(repoRoot, "docs/guide/skills/sfly-platform/SKILL.md"), "utf8");
	const section = /^## 编辑场景\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
	const blocks = [...section.matchAll(/^ *```json\n([\s\S]*?)^ *```$/gm)].map((m) => m[1] ?? "");
	expect(blocks, "「编辑场景」一节要有且只有一个 json 例子").toHaveLength(1);
	return blocks[0] ?? "";
}

describe("sfly-platform skill「编辑场景」的例子 → sfly scenario push", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "probe-kit", "1.0.0", {
			wait_ready: ["base_url"],
			check: ["base_url"],
		});
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
		dir = await mkdtemp(join(tmpdir(), "sfly-skill-edit-example-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("新节点写了 id、kind、package、node、display_name、inputs，没写坐标；连线写了 from、to、kind", async () => {
		const fragment = JSON.parse(await skillExample()) as Fragment;
		expect(fragment.nodes).toHaveLength(1);
		expect(Object.keys(fragment.nodes[0] ?? {}).sort()).toEqual(
			["display_name", "id", "inputs", "kind", "node", "package"].sort(),
		);
		expect(fragment.edges).toHaveLength(1);
		expect(Object.keys(fragment.edges[0] ?? {}).sort()).toEqual(["from", "kind", "to"]);
	});

	it("拼进一份场景文档后 push：保存成新版本，没有警告", async () => {
		const filled = (await skillExample())
			.replaceAll("<新节点 id>", "check_items")
			.replaceAll("<包名>", "probe-kit")
			.replaceAll("<节点名>", "check")
			.replaceAll("<说明它做什么的显示名称>", "检查商品列表")
			.replaceAll("<输入名>", "base_url")
			.replaceAll("<值>", "http://sut:9000")
			.replaceAll("<前一个节点 id>", "wait_ready");
		expect(filled, "例子里还有没替换的占位").not.toMatch(/<[^>]+>/);
		const fragment = JSON.parse(filled) as Fragment;

		const id = await api.createOrchestration("编辑场景的例子");
		const file = join(dir, "scenario.json");
		expect((await cli("scenario", "pull", id, "-o", file)).code).toBe(0);
		const pulled = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		const document = {
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
				...fragment.nodes,
			],
			edges: [{ from: "entry", to: "wait_ready", kind: "chain" }, ...fragment.edges],
			packages: { "probe-kit": "1.0.0" },
			annotations: [],
		};
		await writeFile(file, JSON.stringify({ ...pulled, document }, null, 2));

		const result = await cli("scenario", "push", file, "--json");
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).warnings).toEqual([]);
		expect(await api.headVersion(id)).toBe(1);
	});
});
