// 升级前保存的场景版本（#310 的验收问题）：库里的文档没有后来新增的字段（注释框 annotations），
// 控制面读出时按场景文档 schema 补上默认值，接口返回的文档和类型一致。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { dropDocumentFields } from "./support/legacy-document.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const document = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
		{ id: "wait", kind: "sleep", duration: "5s", position: { x: 252, y: 0 } },
	],
	edges: [{ from: "entry", to: "wait", kind: "chain" }],
};

interface WithDocument {
	document: { annotations?: unknown; nodes: unknown[] };
}

describe("升级前保存的场景版本：库里的文档没有 annotations", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
	});

	/** 写一个绑定第 1 版的运行（不经过引擎：只要它绑定的版本）。 */
	async function runOnVersion1(scenario: string): Promise<string> {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const run = "00000000-0000-4000-8000-0000000000aa";
			const at = "2026-01-01T00:00:00Z";
			await client.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status,
					started_at, ended_at)
				select $1, $2, id, 'default', '旧人', '{}', 'success', $3, $3
				from orchestration_versions where orchestration_id = $2 and number = 1`,
				[run, scenario, at],
			);
			return run;
		} finally {
			await client.end();
		}
	}

	it("最新版本、历史版本、运行绑定的版本、恢复和复制返回的文档都带 annotations: []", async () => {
		const id = await api.createOrchestration("旧场景");
		await api.saveVersion(id, document);
		await api.saveVersion(id, { ...document, default_agent: "agent-b" });
		await dropDocumentFields(cp, id, ["annotations"]);
		const run = await runOnVersion1(id);

		const head = await api.getJson<WithDocument>(`/orchestrations/${id}/head`);
		expect(head.document.annotations).toEqual([]);
		const v2 = await api.getJson<WithDocument>(`/orchestrations/${id}/versions/2`);
		expect(v2.document.annotations).toEqual([]);

		const bound = (await api.run(run)).orchestration_version;
		expect(bound).toBe(1);
		const v1 = await api.getJson<WithDocument>(`/orchestrations/${id}/versions/${bound}`);
		expect(v1.document.annotations).toEqual([]);
		expect(v1.document.nodes).toHaveLength(2);

		const restored = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
		expect(restored.status).toBe(201);
		expect(((await restored.json()) as WithDocument).document.annotations).toEqual([]);

		const copied = await api.post(`/orchestrations/${id}/copy`, { name: "旧场景的副本" });
		expect(copied.status).toBe(201);
		const { id: copy } = (await copied.json()) as { id: string };
		const copyHead = await api.getJson<WithDocument>(`/orchestrations/${copy}/head`);
		expect(copyHead.document.annotations).toEqual([]);
	});
});
