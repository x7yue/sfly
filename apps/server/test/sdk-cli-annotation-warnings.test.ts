// 注释框的警告（#316）：真实的 sfly 进程对着测试控制面，`scenario push` 引用了不存在成员、没有成员、
// 成员写了两次的注释框，打印指出注释框和成员的警告，`--json` 里带 annotation_id；这些警告不阻断触发。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const baseDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ ...echo("pause"), display_name: "等灰度" },
		{ id: "spawn", kind: "async" },
		{ id: "sub", kind: "subflow_entry", name: "report", params: [] },
		echo("wait"),
	],
	edges: [
		{ from: "entry", to: "pause", kind: "chain" },
		{ from: "pause", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "wait", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};

const annotations = [
	{
		id: "annotation_1",
		title: "造测试数据",
		nodes: ["pause", "http_request_9", "pause"],
		subflows: ["nowhere"],
	},
	{ id: "annotation_2", title: "还没想好", nodes: [], subflows: [] },
	{ id: "annotation_3", title: "正常", nodes: ["entry"], subflows: ["sub"] },
];

const MESSAGES = [
	"注释框「造测试数据」（annotation_1）把节点 等灰度（pause） 写了 2 次",
	"注释框「造测试数据」（annotation_1）引用了不存在的节点 http_request_9",
	"注释框「造测试数据」（annotation_1）引用了不存在的子流程 nowhere（子流程成员写子流程入口节点的节点 ID，不是子流程名称）",
	"注释框「还没想好」（annotation_2）没有成员",
];

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: Record<string, unknown>;
}

describe("sfly scenario push：注释框的警告 → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	let fileCount = 0;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	/** 新场景、pull 出文件、换上带这些注释框的文档，返回场景 id 和文件。 */
	const prepared = async (name: string, document: object) => {
		const id = await api.createOrchestration(name);
		const file = join(dir, `scenario-${++fileCount}.json`);
		const pulled = await cli("scenario", "pull", id, "-o", file);
		expect(pulled.code, pulled.stderr).toBe(0);
		const content = JSON.parse(await readFile(file, "utf8")) as ScenarioFile;
		await writeFile(file, JSON.stringify({ ...content, document }, null, 2));
		return { id, file };
	};

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		// 触发前的预检要求节点包已发布、Agent 已注册（不必在线）。
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
		dir = await mkdtemp(join(tmpdir(), "sfly-annotation-warnings-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("文本输出：保存成功，「警告」下逐条指出是哪个注释框、哪个成员", async () => {
		const { id, file } = await prepared("推送写错的注释框", { ...baseDocument, annotations });
		const result = await cli("scenario", "push", file);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(`已保存场景 ${id} 的版本 1`);
		expect(result.stdout).toContain(["警告（4）：", ...MESSAGES.map((m) => `  ${m}`)].join("\n"));
		expect(await api.headVersion(id)).toBe(1);
	});

	it("--json：每条警告带 annotation_id，没有 node_id", async () => {
		const { file } = await prepared("推送写错的注释框 JSON", { ...baseDocument, annotations });
		const result = await cli("scenario", "push", file, "--json");
		expect(result.code, result.stderr).toBe(0);
		const { warnings } = JSON.parse(result.stdout) as { warnings: Record<string, unknown>[] };
		expect(warnings).toEqual([
			{
				code: "annotation_duplicate_member",
				message: MESSAGES[0],
				annotation_id: "annotation_1",
			},
			{ code: "annotation_unknown_node", message: MESSAGES[1], annotation_id: "annotation_1" },
			{ code: "annotation_unknown_subflow", message: MESSAGES[2], annotation_id: "annotation_1" },
			{ code: "annotation_no_members", message: MESSAGES[3], annotation_id: "annotation_2" },
		]);
	});

	it("写对了的注释框没有警告", async () => {
		const { file } = await prepared("推送写对的注释框", {
			...baseDocument,
			annotations: [annotations[2]],
		});
		const result = await cli("scenario", "push", file);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).not.toContain("警告");
	});

	it("不阻断触发：有这些警告的场景，用命令行触发照样成功", async () => {
		const { id, file } = await prepared("带警告也能触发", { ...baseDocument, annotations });
		expect((await cli("scenario", "push", file)).code).toBe(0);
		const started = await cli("run", "start", id, "--json");
		expect(started.code, started.stderr).toBe(0);
		const { id: runId } = JSON.parse(started.stdout) as { id: string };
		await api.cancelOk(runId);
	});
});
