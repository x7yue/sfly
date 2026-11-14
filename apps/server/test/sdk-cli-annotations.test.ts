// 注释框（#310）：真实的 sfly 进程对着测试控制面，`scenario push` 能带着不写坐标的 annotations 保存，
// `scenario show` 列出注释框，注释框 ID 重复时 push 失败并报出位置。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SAVED_AT = "2026-03-04T05:06:07.000Z";

const baseDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], display_name: "开始" },
		{
			id: "deploy",
			kind: "package",
			package: "stub",
			node: "echo",
			agent: "agent-b",
			display_name: "部署服务",
		},
		{ id: "spawn", kind: "async" },
		{ id: "pause", kind: "sleep", duration: "5s" },
		{ id: "sub", kind: "subflow_entry", name: "report" },
		{ id: "send", kind: "package", package: "stub", node: "echo" },
	],
	edges: [
		{ from: "entry", to: "deploy", kind: "chain" },
		{ from: "deploy", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "pause", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "send", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};

interface Annotation {
	id: string;
	title: string;
	note?: string;
	nodes: string[];
	subflows: string[];
}

const annotations: Annotation[] = [
	{
		id: "annotation_1",
		title: "发布与灰度",
		note: "先发布到测试环境\n\n再等灰度生效",
		nodes: ["deploy", "pause"],
		subflows: [],
	},
	{ id: "annotation_2", title: "汇报", nodes: [], subflows: ["sub"] },
	{
		id: "annotation_3",
		title: "派发到汇报",
		note: "异步任务和它触发的子流程",
		nodes: ["entry", "spawn", "sub", "gone"],
		subflows: ["sub", "nowhere"],
	},
	{ id: "annotation_4", title: "还没想好", nodes: [], subflows: [] },
];

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: { annotations?: Annotation[] };
}

describe("sfly scenario show / push：注释框 → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	let cliVersion: string;
	const clock = new ManualClock(SAVED_AT);
	let fileCount = 0;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	const createScenario = async (name: string, document: unknown): Promise<string> => {
		const res = await api.post("/orchestrations", { name });
		const { id } = (await res.json()) as { id: string };
		await api.saveVersion(id, document);
		clock.advance(1000);
		return id;
	};
	const head = (id: string) =>
		api.getJson<{ document: ScenarioFile["document"] }>(`/orchestrations/${id}/head`);
	const pull = async (id: string): Promise<{ file: string; content: ScenarioFile }> => {
		const file = join(dir, `scenario-${++fileCount}.json`);
		const result = await cli("scenario", "pull", id, "-o", file);
		expect(result.code, result.stderr).toBe(0);
		return { file, content: JSON.parse(await readFile(file, "utf8")) as ScenarioFile };
	};

	beforeAll(async () => {
		cliVersion = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ clock, version: cliVersion });
		api = new ApiClient(cp);
		dir = await mkdtemp(join(tmpdir(), "sfly-annotations-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("push", () => {
		it("不写坐标的注释框能 push：备注去掉首尾空白后保存，没写备注的注释框不出现 note", async () => {
			const id = await createScenario("推送注释框", baseDocument);
			const { file, content } = await pull(id);
			expect(content.document.annotations).toEqual([]);
			content.document.annotations = annotations.map((a) =>
				a.id === "annotation_1" ? { ...a, note: "  先发布到测试环境\n\n再等灰度生效\n " } : a,
			);
			await writeFile(file, JSON.stringify(content, null, 2));

			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			const saved = (await head(id)).document.annotations;
			expect(saved).toEqual(annotations);
			expect(saved?.[1]).not.toHaveProperty("note");
			expect((await cli("scenario", "show", id)).stdout).toContain(
				"注释框：\n  发布与灰度（annotation_1）",
			);
		});

		it("注释框 ID 重复：本地校验认不出来，控制面拒绝，push 失败并报出第二个注释框的 id 位置，不保存新版本", async () => {
			const id = await createScenario("推送重复 ID", baseDocument);
			const version = await api.headVersion(id);
			const { file, content } = await pull(id);
			content.document.annotations = [
				{ id: "annotation_1", title: "第一个", nodes: ["deploy"], subflows: [] },
				{ id: "annotation_1", title: "第二个", nodes: ["pause"], subflows: [] },
			];
			await writeFile(file, JSON.stringify(content, null, 2));

			const result = await cli("scenario", "push", file);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("控制面认为场景文档不合法");
			expect(result.stderr).toContain("document/annotations/1/id: 注释框 ID annotation_1 重复");
			expect(await api.headVersion(id)).toBe(version);
		});
	});

	describe("show", () => {
		it("文本输出：最后一段「注释框」：标题和 ID，成员（节点写显示名称和节点 ID，子流程写名称），备注缩进对齐；没有注释框的场景没有这一段", async () => {
			clock.set(SAVED_AT);
			const id = await createScenario("有注释框", { ...baseDocument, annotations });
			const result = await cli("scenario", "show", id);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					`场景 有注释框（${id}）`,
					`最新版本：1，tester 保存于 ${SAVED_AT}`,
					"默认 Agent：agent-a",
					"",
					"主链（入口 开始（entry））",
					"  入口参数：无",
					"  节点：",
					"    节点    显示名称  节点类型                  包版本  Agent",
					"    deploy  部署服务  stub/echo                 1.0.0   agent-b",
					"    spawn   -         异步任务 → 子流程 report  -       -",
					"    pause   -         Sleep                     -       -",
					"",
					"子流程 report（入口 sub，由 spawn 触发）",
					"  入口参数：无",
					"  节点：",
					"    节点  显示名称  节点类型   包版本  Agent",
					"    send  -         stub/echo  1.0.0   agent-a",
					"",
					"注释框：",
					"  发布与灰度（annotation_1）",
					"    节点：部署服务（deploy）、pause",
					"    备注：先发布到测试环境",
					"",
					"          再等灰度生效",
					"  汇报（annotation_2）",
					"    子流程：report",
					"  派发到汇报（annotation_3）",
					"    节点：开始（entry）、spawn、report（sub）、gone；子流程：report、nowhere",
					"    备注：异步任务和它触发的子流程",
					"  还没想好（annotation_4）",
					"    成员：无",
					"",
				].join("\n"),
			);

			const plain = await createScenario("空白场景", baseDocument);
			expect((await cli("scenario", "show", plain)).stdout).not.toContain("注释框");
		});

		it("--json：annotations 一直在（没有时是空数组），每项是文档里的 id、title、note（有才有）、nodes、subflows", async () => {
			const id = await createScenario("有注释框 JSON", { ...baseDocument, annotations });
			const result = await cli("scenario", "show", id, "--json");
			expect(result.code, result.stderr).toBe(0);
			const json = JSON.parse(result.stdout) as { annotations: Annotation[] };
			expect(json.annotations).toEqual(annotations);
			expect(json.annotations[1]).not.toHaveProperty("note");

			const plain = await createScenario("空白场景 JSON", baseDocument);
			const empty = JSON.parse((await cli("scenario", "show", plain, "--json")).stdout);
			expect(empty.annotations).toEqual([]);
		});
	});
});
