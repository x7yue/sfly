// 节点的备注（#308）：真实的 sfly 进程对着测试控制面，`scenario show` 列出备注，`scenario push` 能带着备注保存。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SAVED_AT = "2026-03-04T05:06:07.000Z";
const EMOJI = "😀";

const notedDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], note: "整个场景的说明：先发布，再等灰度" },
		{
			id: "deploy",
			kind: "package",
			package: "stub",
			node: "echo",
			agent: "agent-b",
			note: "发布到测试环境\n超时设为 600 秒，因为镜像很大\n\n别改成 always",
		},
		{ id: "spawn", kind: "async" },
		{ id: "pause", kind: "sleep", duration: "5s", note: "等灰度生效" },
		{ id: "sub", kind: "subflow_entry", name: "report", note: "报告子流程：汇总并发给值班同学" },
		{ id: "send", kind: "package", package: "stub", node: "echo", note: "只发一次" },
		{ id: "loose", kind: "timer", at: "10:00:00", note: "还没接进任何链\n接好之后删掉" },
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

const plainDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: { nodes: { id: string; note?: string }[] };
}

describe("sfly scenario show / push：节点的备注 → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	let cliVersion: string;
	const clock = new ManualClock(SAVED_AT);
	const proxies: RecordingProxy[] = [];
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
	const noteOf = (document: ScenarioFile["document"], id: string) =>
		document.nodes.find((n) => n.id === id)?.note;
	/** 给文件里的节点写上备注。 */
	const setNote = (content: ScenarioFile, id: string, note: string) => {
		const node = content.document.nodes.find((n) => n.id === id);
		if (!node) throw new Error(`文件里没有节点 ${id}`);
		node.note = note;
	};

	beforeAll(async () => {
		cliVersion = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ clock, version: cliVersion });
		api = new ApiClient(cp);
		dir = await mkdtemp(join(tmpdir(), "sfly-node-note-"));
	}, 120_000);

	afterAll(async () => {
		await Promise.all(proxies.map((p) => p.close()));
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("show", () => {
		it("文本输出：每条链的节点表下面列出这条链的备注，多行备注缩进对齐；没有备注的链不加这一段", async () => {
			const id = await createScenario("有备注", notedDocument);
			const result = await cli("scenario", "show", id);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					`场景 有备注（${id}）`,
					`最新版本：1，tester 保存于 ${SAVED_AT}`,
					"默认 Agent：agent-a",
					"",
					"主链",
					"  入口参数：无",
					"  节点：",
					"    节点    显示名称  节点类型                  包版本  Agent",
					"    deploy  -         stub/echo                 1.0.0   agent-b",
					"    spawn   -         异步任务 → 子流程 report  -       -",
					"    pause   -         Sleep                     -       -",
					"  备注：",
					"    entry：整个场景的说明：先发布，再等灰度",
					"    deploy：发布到测试环境",
					"            超时设为 600 秒，因为镜像很大",
					"",
					"            别改成 always",
					"    pause：等灰度生效",
					"",
					"子流程 report（入口 sub，由 spawn 触发）",
					"  入口参数：无",
					"  节点：",
					"    节点  显示名称  节点类型   包版本  Agent",
					"    send  -         stub/echo  1.0.0   agent-a",
					"  备注：",
					"    sub：报告子流程：汇总并发给值班同学",
					"    send：只发一次",
					"",
					"没有连进任何链的节点：",
					"  节点   显示名称  节点类型  包版本  Agent",
					"  loose  -         定时      -       -",
					"  备注：",
					"    loose：还没接进任何链",
					"           接好之后删掉",
					"",
				].join("\n"),
			);

			const plain = await createScenario("空白场景", plainDocument);
			expect((await cli("scenario", "show", plain)).stdout).not.toContain("备注");
		});

		it("--json：节点带 note，入口节点的备注在 entry_note，没有备注的节点不出现这个字段", async () => {
			const id = await createScenario("有备注 JSON", notedDocument);
			const result = await cli("scenario", "show", id, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				entry_note: "整个场景的说明：先发布，再等灰度",
				nodes: [
					{ id: "deploy", note: "发布到测试环境\n超时设为 600 秒，因为镜像很大\n\n别改成 always" },
					{ id: "spawn" },
					{ id: "pause", note: "等灰度生效" },
				],
				subflows: [
					{
						entry: "sub",
						entry_note: "报告子流程：汇总并发给值班同学",
						nodes: [{ id: "send", note: "只发一次" }],
					},
				],
				unlinked: [{ id: "loose", note: "还没接进任何链\n接好之后删掉" }],
			});
			const json = JSON.parse(result.stdout) as { nodes: Record<string, unknown>[] };
			expect(json.nodes[1]).not.toHaveProperty("note");

			const plain = await createScenario("空白场景 JSON", plainDocument);
			expect((await cli("scenario", "show", plain, "--json")).stdout).not.toContain("note");
		});
	});

	describe("push", () => {
		it("带备注的文档能 push：备注去掉首尾空白后保存，空备注不保存；push 之后 show 能看到", async () => {
			const id = await createScenario("推送备注", plainDocument);
			const { file, content } = await pull(id);
			setNote(content, "a", "  先建用户\n再查订单\n");
			setNote(content, "entry", "   ");
			await writeFile(file, JSON.stringify(content, null, 2));

			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			const saved = (await head(id)).document;
			expect(noteOf(saved, "a")).toBe("先建用户\n再查订单");
			expect(saved.nodes[0]).not.toHaveProperty("note");
			const shown = await cli("scenario", "show", id);
			expect(shown.stdout).toContain("  备注：\n    a：先建用户\n       再查订单");
		});

		it("备注最长 2000 个字符：2000 个 emoji 能 push，2001 个本地校验报出位置，控制面的判断相同", async () => {
			const id = await createScenario("推送备注长度", plainDocument);
			const { file, content } = await pull(id);
			setNote(content, "a", EMOJI.repeat(2000));
			await writeFile(file, JSON.stringify(content, null, 2));
			const fits = await cli("scenario", "push", file);
			expect(fits.code, fits.stderr).toBe(0);
			expect(noteOf((await head(id)).document, "a")).toBe(EMOJI.repeat(2000));

			const tooLong = (await pull(id)).content;
			setNote(tooLong, "a", EMOJI.repeat(2001));
			await writeFile(file, JSON.stringify(tooLong, null, 2));
			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stdout).toBe("");
			expect(rejected.stderr).toContain("没有通过校验");
			expect(rejected.stderr).toContain("nodes/1/note");
			expect(rejected.stderr).toContain("节点 a");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: tooLong.document,
			});
			expect(direct.status).toBe(400);
			expect(await direct.json()).toMatchObject({ error: { code: "invalid_document" } });
		});
	});
});
