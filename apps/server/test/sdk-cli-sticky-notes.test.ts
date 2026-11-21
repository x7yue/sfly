// 便签（ADR 0026）：真实的 sfly 进程对着测试控制面，`scenario push` 能带着不写坐标的 sticky_notes 保存
// （控制面把它们放进内容上方的那一行），`scenario show` 最后列出便签，便签 ID 重复时 push 失败并报出位置。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo } from "./support/chains.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const baseDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
		{ ...echo("pause"), position: { x: 252, y: 0 } },
	],
	edges: [{ from: "entry", to: "pause", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

interface StickyNote {
	id: string;
	title?: string;
	text: string;
	color?: string;
	position?: { x: number; y: number };
	size?: { width: number; height: number };
}

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: { sticky_notes?: StickyNote[] };
}

describe("sfly scenario show / push：便签 → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	let fileCount = 0;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	const createScenario = async (name: string, document: unknown): Promise<string> => {
		const res = await api.post("/orchestrations", { name });
		const { id } = (await res.json()) as { id: string };
		await api.saveVersion(id, document);
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
		const cliVersion = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ version: cliVersion });
		api = new ApiClient(cp);
		// 保存时不带「节点包没有发布」的警告（push 的输出里不该有警告）。
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		dir = await mkdtemp(join(tmpdir(), "sfly-sticky-notes-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("不写坐标的便签能 push：控制面把它们排成内容上方的一行，写了坐标的不动；正文去掉首尾空白", async () => {
		const id = await createScenario("推送便签", baseDocument);
		const { file, content } = await pull(id);
		expect(content.document.sticky_notes).toEqual([]);
		content.document.sticky_notes = [
			{ id: "sticky_1", title: "跑之前确认", text: "\n- Agent 都在线\n- 升级包已放好\n" },
			{ id: "sticky_2", text: "已知问题", color: "pink", position: { x: 900, y: 400 } },
			{ id: "sticky_3", text: "待办", size: { width: 200, height: 120 } },
		];
		await writeFile(file, JSON.stringify(content, null, 2));

		const result = await cli("scenario", "push", file);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).not.toContain("警告");
		const saved = (await head(id)).document.sticky_notes ?? [];
		expect(saved.map((s) => s.text)).toEqual([
			"- Agent 都在线\n- 升级包已放好",
			"已知问题",
			"待办",
		]);
		expect(saved[1]?.position).toEqual({ x: 900, y: 400 });
		// 一行里上边对齐，按顺序从左到右，都在节点（y = 0）上方。
		const [first, , third] = saved;
		expect(first?.position?.y).toBe(third?.position?.y);
		expect(first?.position?.x).toBeLessThan(third?.position?.x ?? 0);
		expect((first?.position?.y ?? 0) + 168).toBeLessThan(0);
	});

	it("便签 ID 重复：本地校验认不出来，控制面拒绝，push 失败并报出第二张便签的 id 位置，不保存新版本", async () => {
		const id = await createScenario("便签 ID 重复", baseDocument);
		const { file, content } = await pull(id);
		content.document.sticky_notes = [
			{ id: "sticky_1", text: "一" },
			{ id: "sticky_1", text: "二" },
		];
		await writeFile(file, JSON.stringify(content, null, 2));
		const result = await cli("scenario", "push", file);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("document/sticky_notes/1/id: 便签 ID sticky_1 重复");
		expect((await head(id)).document.sticky_notes).toEqual([]);
	});

	it("正文为空：本地校验就拦下，指出出错的位置，不发请求", async () => {
		const id = await createScenario("便签正文为空", baseDocument);
		const { file, content } = await pull(id);
		content.document.sticky_notes = [{ id: "sticky_1", text: "  " }];
		await writeFile(file, JSON.stringify(content, null, 2));
		const result = await cli("scenario", "push", file);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("sticky_notes/0/text");
	});

	it("show：最后一段「便签」：有标题写「标题（ID）」，没有标题只写 ID，正文缩进；--json 的 sticky_notes 有标题、颜色才带", async () => {
		const id = await createScenario("有便签", {
			...baseDocument,
			sticky_notes: [
				{
					id: "sticky_1",
					title: "跑之前确认",
					text: "- Agent 都在线\n\n- 升级包已放好",
					position: { x: 0, y: -300 },
				},
				{ id: "sticky_2", text: "已知问题", color: "pink", position: { x: 300, y: -300 } },
			],
		});
		const text = await cli("scenario", "show", id);
		expect(text.code, text.stderr).toBe(0);
		expect(text.stdout).toContain(
			[
				"便签：",
				"  跑之前确认（sticky_1）",
				"    - Agent 都在线",
				"",
				"    - 升级包已放好",
				"  sticky_2",
				"    已知问题",
				"",
			].join("\n"),
		);
		const json = JSON.parse((await cli("scenario", "show", id, "--json")).stdout) as {
			sticky_notes: StickyNote[];
		};
		expect(json.sticky_notes).toEqual([
			{ id: "sticky_1", title: "跑之前确认", text: "- Agent 都在线\n\n- 升级包已放好" },
			{ id: "sticky_2", text: "已知问题", color: "pink" },
		]);

		const plain = await createScenario("没有便签", baseDocument);
		expect((await cli("scenario", "show", plain)).stdout).not.toContain("便签：");
		const empty = JSON.parse((await cli("scenario", "show", plain, "--json")).stdout);
		expect(empty.sticky_notes).toEqual([]);
	});
});
