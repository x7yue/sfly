// sfly-platform skill「编辑场景」里的例子（#472，#470 改成 scenario edit）：AI 编程助手照它改场景，
// `scenario edit … add --help` 是它会读的另一份说明。把例子里的占位换成真实的值，真实的 sfly 进程照着执行：
// - 这一节唯一的 sh 例子：--dry-run 不产生版本，去掉 --dry-run 存成新版本，都没有警告；
// - 这一节、platform-cli.md「局部编辑」一节里的每个 `--input '…'`、`--input "…"`，add --help 里出现的每一种引用写法
//   （每个 `--input '…'` 和 ${{ … }}）：加一个节点用上它，--dry-run 没有警告。
// skill 是助手唯一的说明书，它教错了没有别的测试会发现（#537 的审查：帮助教了一种不合法的引用写法）。
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

/** skill「编辑场景」一节的正文。 */
async function editSection(): Promise<string> {
	const skill = await readFile(join(repoRoot, "docs/guide/skills/sfly-platform/SKILL.md"), "utf8");
	return /^## 编辑场景\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
}

/** platform-cli.md「局部编辑」一节的正文。 */
async function platformCliEditSection(): Promise<string> {
	const doc = await readFile(join(repoRoot, "docs/guide/platform-cli.md"), "utf8");
	return /^### 局部编辑\n([\s\S]*?)(?=^##? )/m.exec(doc)?.[1] ?? "";
}

/**
 * 一段文字里的 `--input '名=值'`、`--input "名=值"` 例子（引号里的部分）。双引号里的 `$` 会被 shell 展开
 * （`${{` 直接报错），照着抄的人拿不到写的值：双引号的例子里不能有 `$`。
 */
const inputExamples = (text: string): string[] =>
	[...text.matchAll(/--input (?:'([^']+)'|"([^"]+)")/g)].map((m) => {
		if (m[2] !== undefined) {
			expect(m[2], "双引号里的 $ 会被 shell 展开：引用要用单引号").not.toContain("$");
			return m[2];
		}
		return m[1] ?? "";
	});

/** 一段文字里出现的引用（`${{ … }}`），去重。 */
const references = (text: string): string[] => [
	...new Set([...text.matchAll(/\$\{\{[^}]*\}\}/g)].map((m) => m[0])),
];

/** 帮助、文档里引用的占位换成下面场景里真有的名字。 */
const fillReference = (ref: string): string =>
	ref
		.replaceAll("<参数名>", "base_url")
		.replaceAll("<节点 ID>", "fetch_data")
		.replaceAll("<节点>", "fetch_data")
		.replaceAll("<输出键>", "body")
		.replaceAll("<输出>", "body");

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
			fetch: {
				outputs: ["body"],
				inputs: { properties: { base_url: { type: "string" } }, required: ["base_url"] },
			},
			use: {
				outputs: [],
				inputs: {
					properties: {
						url: { type: "string" },
						base_url: { type: "string" },
						body: { type: "string" },
						state: { type: "object", "x-sfly-type": "run_state" },
					},
				},
			},
		});
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
	});

	describe("每一种引用写法照着写都合法", () => {
		/**
		 * 入口参数 base_url → fetch_data（输出 body）。用来试引用的节点类型 use：输入 url、base_url、body 是字符串，
		 * state 是「运行状态」类型；都不是必填。
		 */
		const refScenario = async (name: string) =>
			api.orchestrationWith(
				{
					default_agent: "agent-a",
					nodes: [
						{
							id: "entry",
							kind: "entry",
							params: [{ name: "base_url", type: "string", default: "http://sut:9000" }],
						},
						{
							id: "fetch_data",
							kind: "package",
							package: "probe-kit",
							node: "fetch",
							display_name: "取数据",
							inputs: { base_url: "${{ params.base_url }}" },
						},
					],
					edges: [{ from: "entry", to: "fetch_data", kind: "chain" }],
					packages: { "probe-kit": "1.0.0" },
				},
				name,
			);

		/** 加一个 use 节点接在 fetch_data 后面，用上这个输入（`名=值`）：--dry-run 退出码 0，没有这次带进来的警告。 */
		const dryRunWith = async (id: string, input: string) => {
			const result = await cli([
				"scenario",
				"edit",
				id,
				"add",
				"probe-kit/use",
				"--after",
				"fetch_data",
				"--display-name",
				"用引用",
				"--input",
				input,
				"--dry-run",
				"--json",
			]);
			expect(result.code, `${input}\n${result.stdout}${result.stderr}`).toBe(0);
			const { warnings } = JSON.parse(result.stdout) as { warnings: { existing: boolean }[] };
			expect(
				warnings.filter((w) => !w.existing),
				input,
			).toEqual([]);
		};

		it("skill「编辑场景」一节：三种引用各有一个完整的例子，照着执行没有警告", async () => {
			const examples = inputExamples(await editSection());
			for (const form of ["${{ params.", "${{ nodes.", "${{ run.state }}"]) {
				expect(
					examples.some((e) => e.includes(form)),
					`skill 里缺 ${form} 的例子`,
				).toBe(true);
			}
			const id = await refScenario("skill 的引用例子");
			for (const example of examples) await dryRunWith(id, example);
		});

		it("platform-cli.md「局部编辑」一节：三种引用各有一个例子，照着执行没有警告", async () => {
			const examples = inputExamples(await platformCliEditSection());
			for (const form of ["${{ params.", "${{ nodes.", "${{ run.state }}"]) {
				expect(
					examples.some((e) => e.includes(form)),
					`platform-cli.md 里缺 ${form} 的例子`,
				).toBe(true);
			}
			const id = await refScenario("platform-cli 的引用例子");
			for (const example of examples) await dryRunWith(id, example);
		});

		it("add --help：教的每一种引用写法、每个例子，代入真值执行没有警告", async () => {
			const help = await cli(["scenario", "edit", "x", "add", "--help"]);
			expect(help.code, help.stderr).toBe(0);
			const text = help.stdout.split(/\s+/).join(" ");
			const refs = references(text);
			for (const form of ["${{ params.", "${{ nodes.", "${{ run.state }}"]) {
				expect(
					refs.some((r) => r.startsWith(form)),
					`帮助里缺 ${form}`,
				).toBe(true);
			}
			const id = await refScenario("帮助的引用例子");
			for (const ref of refs) {
				const filled = fillReference(ref);
				expect(filled, "引用里还有没替换的占位").not.toMatch(/<[^>]+>/);
				await dryRunWith(id, `${filled === "${{ run.state }}" ? "state" : "url"}=${filled}`);
			}
			const examples = inputExamples(text);
			expect(examples.length, "帮助里要有一个完整的 --input 例子").toBeGreaterThan(0);
			for (const example of examples) await dryRunWith(id, example);
		});

		it("教错的写法（${{ 节点.输出 }}）确实会被这个测试拦下：带进来一条引用格式的警告", async () => {
			const id = await refScenario("错的引用");
			const result = await cli([
				"scenario",
				"edit",
				id,
				"add",
				"probe-kit/use",
				"--after",
				"fetch_data",
				"--input",
				"url=${{ fetch_data.body }}",
				"--dry-run",
				"--json",
			]);
			expect(result.code).toBe(4);
			expect(JSON.parse(result.stdout).warnings).toContainEqual(
				expect.objectContaining({ code: "reference_invalid", existing: false }),
			);
		});
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
