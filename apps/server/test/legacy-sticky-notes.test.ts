// 便签（`sticky_notes`，ADR 0026）已移除（#445、ADR 0028）；移除之前保存的每个版本都带着这一项（默认是空数组，也可能有内容）。
// 存量数据怎么办：
// 1. 历史运行、历史版本照常能读：版本接口、最新版本、运行视图、运行列表、版本对比、恢复、复制都不报错，读到的文档里没有便签；
// 2. 最新版本里带着便签的场景：预检不阻断触发（便签只用于显示、不执行），触发照常运行，没有已移除节点的警告；
// 3. 保存新版本时不再带上：读到的文档原样保存，恢复、复制产生的新版本同样没有；空的 sticky_notes 接受并丢掉，
//    有内容的被拒绝（写明有几条、怎么办），不产生新版本，有内容的便签不会不声不响地丢掉。
// 不改动已保存的场景版本：版本是不可变的记录，已保存的版本一个字节都不动（恢复和复制是追加新版本）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { removedFieldsMessage } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { addDocumentFields } from "./support/legacy-document.js";
import { storedDocument } from "./support/stored-document.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 有内容的便签：移除之前保存的样子（颜色、位置、大小都写着）。 */
const STICKY_NOTES = [
	{
		id: "sticky_1",
		title: "跑之前确认",
		text: "- Agent 都在线\n- 数据库已备份",
		color: "red",
		position: { x: 0, y: -300 },
		size: { width: 280, height: 168 },
	},
	{ id: "sticky_2", text: "已知问题：夜里会超时", position: { x: 320, y: -300 } },
];

/** 控制面拒绝保存的说明：和命令行本地检查（sfly scenario push）是同一句，写明是哪一项、里面有几条、怎么办。 */
const REMOVED_MESSAGE = removedFieldsMessage([
	{ field: "sticky_notes", count: STICKY_NOTES.length },
]);

/** 只有入口节点和一个注释框的文档：不需要 Agent，能直接触发。 */
const document = {
	nodes: [{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } }],
	edges: [],
	packages: {},
	annotations: [
		{ id: "annotation_1", title: "说明", note: "只有入口", nodes: ["entry"], subflows: [] },
	],
};

interface Doc {
	nodes: unknown[];
	edges: unknown[];
	packages: Record<string, string>;
	annotations: unknown[];
}

interface Problem {
	code: string;
	message: string;
}

describe("便签留在历史数据里", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
	});

	/**
	 * 造一个移除之前的场景：第 1 版、第 2 版内容相同；两个版本上各有一次已经成功的历史运行；之后在库里给第 1 版加上空的
	 * `sticky_notes`、给第 2 版（最新版本）加上有内容的 `sticky_notes`。
	 */
	async function seed(name: string): Promise<{ id: string; runs: [string, string] }> {
		const id = await api.orchestrationWith(document, name);
		const first = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(first)).status).toBe("success"));
		await api.saveVersion(id, document);
		const second = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(second)).status).toBe("success"));
		await addDocumentFields(cp, id, { sticky_notes: [] }, 1);
		await addDocumentFields(cp, id, { sticky_notes: STICKY_NOTES }, 2);
		expect(await storedDocument(cp, id, 1)).toHaveProperty("sticky_notes", []);
		expect(await storedDocument(cp, id, 2)).toHaveProperty("sticky_notes", STICKY_NOTES);
		return { id, runs: [first, second] };
	}

	const version = (id: string, number: number) =>
		api.getJson<{ number: number; document: Doc }>(`/orchestrations/${id}/versions/${number}`);
	const head = (id: string) =>
		api.getJson<{ number: number; document: Doc }>(`/orchestrations/${id}/head`);
	const save = (id: string, body: unknown) => api.post(`/orchestrations/${id}/versions`, body);

	/** 库里这个版本的文档有没有 `sticky_notes` 这一项（直接查原始 JSON）。 */
	async function storedHasStickyNotes(id: string, number: number): Promise<boolean> {
		return Object.hasOwn(await storedDocument(cp, id, number), "sticky_notes");
	}

	describe("历史运行、历史版本照常能读", () => {
		it("历史版本里带着便签（空的、有内容的）：版本接口和最新版本读出不报错，文档里没有便签字段，别的内容原样", async () => {
			const { id } = await seed("历史版本带便签");
			for (const [label, doc] of [
				["第 1 版（空数组）", (await version(id, 1)).document],
				["第 2 版（有内容）", (await version(id, 2)).document],
				["最新版本", (await head(id)).document],
			] as const) {
				expect(doc, label).not.toHaveProperty("sticky_notes");
				expect(doc, label).toEqual(document);
			}
			expect((await head(id)).number).toBe(2);
		});

		it("历史运行绑定的版本里带着便签：运行视图、运行列表、场景的运行列表读出不报错", async () => {
			const { id, runs } = await seed("历史运行带便签");
			for (const [index, runId] of runs.entries()) {
				const run = await api.run(runId);
				expect(run.status).toBe("success");
				expect(run.orchestration_version).toBe(index + 1);
				expect(run.chains[0]?.nodes.map((n) => [n.node_id, n.kind, n.status])).toEqual([
					["entry", "entry", "success"],
				]);
				// 运行绑定的版本（运行视图按它认节点种类）读出来也没有便签。
				expect(await version(id, run.orchestration_version)).toMatchObject({ document });
			}
			const list = await api.getJson<{ runs: Array<{ id: string; status: string }> }>(
				`/projects/default/runs?orchestration_id=${id}`,
			);
			expect(list.runs.map((r) => r.id).sort()).toEqual([...runs].sort());
			const own = await api.getJson<{ runs: Array<{ id: string }> }>(`/orchestrations/${id}/runs`);
			expect(own.runs.map((r) => r.id).sort()).toEqual([...runs].sort());
		});

		it("版本对比：带空便签的第 1 版和带有内容便签的第 2 版读出来是同一份文档，对比没有差别", async () => {
			const { id } = await seed("版本对比");
			const [v1, v2] = [await version(id, 1), await version(id, 2)];
			expect(v1.document).toEqual(v2.document);
		});

		it("历史版本带着便签、又解析不了现在的文档格式：原样返回的文档里也没有便签字段，别的内容照旧", async () => {
			const { id } = await seed("解析不了的版本");
			// 一个现在的格式里没有的顶层字段：按现在的格式解析失败，读出时原样返回这份文档。
			await addDocumentFields(cp, id, { legacy_field: "旧版本才有的字段" }, 1);
			const raw = (await version(id, 1)).document;
			expect(raw).not.toHaveProperty("sticky_notes");
			expect(raw).toMatchObject({ legacy_field: "旧版本才有的字段", nodes: document.nodes });
			expect(await storedHasStickyNotes(id, 1)).toBe(true);
		});
	});

	describe("最新版本里带着便签的场景", () => {
		it("预检不阻断触发，也没有已移除节点的警告；触发照常运行到成功", async () => {
			const { id } = await seed("便签不阻断触发");
			const preflight = await api.getJson<{
				version: number;
				problems: Problem[];
				warnings: Problem[];
			}>(`/orchestrations/${id}/preflight`);
			expect(preflight.version).toBe(2);
			expect(preflight.problems).toEqual([]);
			expect(preflight.warnings.filter((w) => w.code === "node_kind_removed")).toEqual([]);

			const runId = await api.triggerOk(id);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			expect((await api.run(runId)).orchestration_version).toBe(2);
		});
	});

	describe("升级后导出有内容的便签", () => {
		it("ADR 0028 第 3 步里给的查询能用：只列出有内容的版本，带着场景名、版本号和便签内容；读取接口读不到了", async () => {
			const { id } = await seed("导出便签");
			const adr = await readFile(
				join(repoRoot, "docs/adr/0028-remove-unused-node-kinds-and-canvas-features.md"),
				"utf8",
			);
			// 直接取 ADR 里的那条查询原文来跑，文档里的写法错了这里会失败。
			const query = /`(select o\.name, v\.number,[^`]+;)`/.exec(adr)?.[1];
			expect(query, "ADR 里没有找到导出便签的查询").toBeDefined();
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				const { rows } = await client.query<{
					name: string;
					number: number;
					sticky_notes: unknown;
				}>(query as string);
				const mine = rows.filter((r) => r.name === "导出便签");
				expect(mine.map((r) => r.number)).toEqual([2]);
				expect(mine[0]?.sticky_notes).toEqual(STICKY_NOTES);
				// 第 1 版带着空数组，不在结果里。
				expect(rows.some((r) => r.name === "导出便签" && r.number === 1)).toBe(false);
			} finally {
				await client.end();
			}
			expect((await version(id, 2)).document).not.toHaveProperty("sticky_notes");
		});
	});

	describe("保存新版本时不再带上便签", () => {
		it("用读到的最新版本原样保存：新版本里没有便签（直接查库），已保存的版本一个字节都不动", async () => {
			const { id } = await seed("原样保存");
			const before = [await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)];

			const { document: current } = await head(id);
			const res = await save(id, { base_version: 2, document: current });
			expect(res.status, await res.clone().text()).toBe(201);
			const saved = (await res.json()) as { number: number; document: Doc; warnings: Problem[] };
			expect(saved.number).toBe(3);
			expect(saved.document).not.toHaveProperty("sticky_notes");
			expect(saved.warnings.filter((w) => w.code === "node_kind_removed")).toEqual([]);

			expect(await storedHasStickyNotes(id, 3)).toBe(false);
			expect(await storedDocument(cp, id, 3)).toEqual(document);
			expect([await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)]).toEqual(before);
			expect(await storedHasStickyNotes(id, 1)).toBe(true);
			expect(await storedHasStickyNotes(id, 2)).toBe(true);
		});

		it("恢复带着便签的历史版本：新版本里没有便签（直接查库），已保存的版本一个字节都不动", async () => {
			const { id } = await seed("恢复");
			const before = [await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)];

			for (const [source, expected] of [
				[2, 3],
				[1, 4],
			] as const) {
				const res = await api.postEmpty(`/orchestrations/${id}/versions/${source}/restore`);
				expect(res.status, await res.clone().text()).toBe(201);
				const restored = (await res.json()) as { number: number; document: Doc };
				expect(restored.number).toBe(expected);
				expect(restored.document).not.toHaveProperty("sticky_notes");
				expect(await storedHasStickyNotes(id, expected)).toBe(false);
				expect(await storedDocument(cp, id, expected)).toEqual(document);
			}
			expect([await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)]).toEqual(before);
		});

		it("复制最新版本带着便签的场景：副本的第 1 版里没有便签（直接查库），源场景的版本一个字节都不动", async () => {
			const { id } = await seed("复制");
			const before = [await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)];

			const res = await api.post(`/orchestrations/${id}/copy`, { name: "副本" });
			expect(res.status, await res.clone().text()).toBe(201);
			const { id: copy } = (await res.json()) as { id: string };
			expect((await head(copy)).document).not.toHaveProperty("sticky_notes");
			expect(await storedHasStickyNotes(copy, 1)).toBe(false);
			expect(await storedDocument(cp, copy, 1)).toEqual(document);
			expect([await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)]).toEqual(before);
		});

		it("文档里带着空的 sticky_notes（读出来改一处再存回去的常见写法）：接受并丢掉，新版本里没有它，已保存的版本不动", async () => {
			const { id } = await seed("空便签保存");
			const before = [await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)];

			const res = await save(id, {
				base_version: 2,
				document: {
					...document,
					annotations: [{ ...document.annotations[0], note: "改了一处" }],
					sticky_notes: [],
				},
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const saved = (await res.json()) as { number: number; document: Doc };
			expect(saved.number).toBe(3);
			expect(saved.document).not.toHaveProperty("sticky_notes");
			expect(await storedHasStickyNotes(id, 3)).toBe(false);
			expect(await storedDocument(cp, id, 3)).toMatchObject({
				annotations: [{ note: "改了一处" }],
			});
			expect([await storedDocument(cp, id, 1), await storedDocument(cp, id, 2)]).toEqual(before);
		});

		it("文档里带着有内容的 sticky_notes：保存被拒绝，错误信息写明有几条、怎么办，不产生新版本，有内容的便签不会悄悄丢掉", async () => {
			const { id } = await seed("带内容的便签保存");
			const res = await save(id, {
				base_version: 2,
				document: { ...document, sticky_notes: STICKY_NOTES },
			});
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("invalid_document");
			expect(error.message).toBe(REMOVED_MESSAGE);
			expect(error.message).toContain("sticky_notes（便签）有 2 条内容");
			expect(error.message).toContain("先把要留的内容挪走，再把这一项删掉");
			expect(error.message).toContain("替换办法：便签：要留的内容写进节点的备注或注释框的备注");
			expect((await head(id)).number).toBe(2);
			expect(await api.headVersion(id)).toBe(2);
			// 被拒绝的内容还在库里的旧版本上：升级前后都能直接读到（见 ADR 0028 第 3 步里的导出办法）。
			expect(await storedDocument(cp, id, 2)).toHaveProperty("sticky_notes", STICKY_NOTES);
		});

		it("空的 sticky_notes 和别的错误同时存在：错误信息只说别的错误，不提便签", async () => {
			const { id } = await seed("空便签加别的错误");
			const res = await save(id, {
				base_version: 2,
				document: { ...document, nodes: [{ id: "x", kind: "no_such_kind" }], sticky_notes: [] },
			});
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { message: string } };
			expect(error.message).not.toContain("sticky_notes");
			expect(error.message).not.toContain("便签");
		});
	});
});
