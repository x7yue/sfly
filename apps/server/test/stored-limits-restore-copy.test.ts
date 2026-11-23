// 节点的超时、排队超时写了不合格的值：保存和检查拒绝（400），升级前保存的版本里可以已经有超限的值（#476、#559）。
// 恢复历史版本、复制场景是把已经存下的文档原样写成新版本，不过保存时的检查（#576）：库里已有的东西不因为升了级就
// 恢复不了、复制不了，但问题不能悄悄带过去——响应的 `warnings` 里每个这样的字段一条（和触发前预检同一句话），
// 要保存任何改动（含改别的字段）之前先把它改成合格的值，保存和检查的 400 写明是哪个节点的哪个字段。
// 另外：保存和检查对 0、负数、小数、字符串也写明节点、字段、范围、实际的值，不再只说文档不符合 schema。
// 真实 PostgreSQL + 完整的 HTTP API；共用的值表在 testdata/node-timeout-value-cases.json。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cases from "../../../testdata/node-timeout-value-cases.json" with { type: "json" };
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { IDS, seedRemovedKindScenario } from "./support/removed-kind-scenario.js";
import { storeNodeField } from "./support/stored-over-limit.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TIMEOUT_TOO_LARGE = 5_000_000_000;
const QUEUE_TOO_LARGE = 9_000_000_000_000;
const sentence = (label: string, field: string, actual: string | number) =>
	`节点 ${label}：${field} 必须是 1 到 4294967295 之间的正整数（秒），实际是 ${actual}`;

interface Warning {
	code: string;
	message: string;
	node_id?: string;
	target?: string;
}
interface WithWarnings {
	number?: number;
	head_version?: number;
	warnings: Warning[];
	document?: { nodes: Array<Record<string, unknown>> };
}

describe("节点的超时、排队超时：保存、检查、恢复历史版本、复制场景", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }); // 触发要求 Agent 注册过
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 入口加一个包节点 `a`（可以带显示名称、超时和排队超时）。 */
	const scenario = (node: Record<string, unknown> = {}, defaultAgent = "agent-a") => ({
		default_agent: defaultAgent,
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "a", kind: "package", package: "stub", node: "echo", inputs: {}, ...node },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { stub: "1.0.0" },
	});
	const errorOf = async (res: Response) =>
		((await res.json()) as { error: { code: string; message: string } }).error;

	describe("保存和检查：不合格的值写明节点、字段、范围、实际的值", () => {
		// 只在 JSON 文本里才是那个值的（1e400）不经 `JSON.stringify` 发：schema 和命令行的测试覆盖。
		interface ValueCase {
			name: string;
			value?: unknown;
			string_from_code_units?: number[];
			actual: string;
			json_text_only?: boolean;
		}
		const valueOf = (c: ValueCase): unknown =>
			c.string_from_code_units ? String.fromCharCode(...c.string_from_code_units) : c.value;
		const values = (cases.values as ValueCase[]).filter((v) => !v.json_text_only);
		const fields = cases.fields as Array<"timeout" | "queue_timeout">;

		for (const field of fields) {
			it.each(values.map((v) => [v.name, v] as const))(`${field}：%s`, async (_, v) => {
				const id = await api.createOrchestration(`值-${field}`);
				const document = scenario({ display_name: "等槽位", [field]: valueOf(v) });

				const saved = await api.post(`/orchestrations/${id}/versions`, {
					base_version: 0,
					document,
				});
				const checked = await api.post(`/orchestrations/${id}/check`, { document });

				for (const res of [saved, checked]) {
					expect(res.status).toBe(400);
					const error = await errorOf(res);
					expect(error.code).toBe("invalid_document");
					expect(error.message).toBe(sentence("等槽位（a）", field, v.actual));
				}
				// 保存没有留下版本。
				expect(await api.headVersion(id)).toBe(0);
			});
		}
	});

	describe("恢复历史版本", () => {
		/** 版本 1 里的超时和排队超时是超限的（升级前保存的），最新版本 2 里是合格的；返回场景 ID。 */
		const withOverLimitVersion = async () => {
			const id = await api.orchestrationWith(
				scenario({ display_name: "等槽位", timeout: 60, queue_timeout: 120 }),
			);
			await api.saveVersion(
				id,
				scenario({ display_name: "等槽位", timeout: 60, queue_timeout: 120 }, "agent-b"),
			);
			await storeNodeField(cp.database.url, id, "a", "timeout", TIMEOUT_TOO_LARGE, 1);
			await storeNodeField(cp.database.url, id, "a", "queue_timeout", QUEUE_TOO_LARGE, 1);
			return id;
		};

		it("能恢复：新版本里原样带着超限的值，响应的 warnings 里每个字段一条，指到这个节点和字段，和预检同一句话", async () => {
			const id = await withOverLimitVersion();

			const res = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);

			expect(res.status).toBe(201);
			const body = (await res.json()) as WithWarnings;
			expect(body.number).toBe(3);
			expect(body.document?.nodes[1]).toMatchObject({
				timeout: TIMEOUT_TOO_LARGE,
				queue_timeout: QUEUE_TOO_LARGE,
			});
			expect(body.warnings.filter((w) => w.code.endsWith("_out_of_range"))).toEqual([
				expect.objectContaining({
					code: "timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "timeout", TIMEOUT_TOO_LARGE),
				}),
				expect.objectContaining({
					code: "queue_timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "queue_timeout", QUEUE_TOO_LARGE),
				}),
			]);
		});

		it("库里存着 null（schema 从第一版起就不收，只可能是直接改库）：不是「没写」，恢复、复制的警告和预检报「实际是 null」，和保存是同一个口径", async () => {
			const id = await api.orchestrationWith(
				scenario({ display_name: "等槽位", timeout: 60, queue_timeout: 120 }),
			);
			await storeNodeField(cp.database.url, id, "a", "timeout", null);
			await storeNodeField(cp.database.url, id, "a", "queue_timeout", null);
			const nullWarnings = [
				expect.objectContaining({
					code: "timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "timeout", "null"),
				}),
				expect.objectContaining({
					code: "queue_timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "queue_timeout", "null"),
				}),
			];

			const restored = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
			const copied = await api.post(`/orchestrations/${id}/copy`, { name: "副本" });

			expect(restored.status).toBe(201);
			expect(
				((await restored.json()) as WithWarnings).warnings.filter((w) =>
					w.code.endsWith("_out_of_range"),
				),
			).toEqual(nullWarnings);
			expect(copied.status).toBe(201);
			expect(
				((await copied.json()) as WithWarnings).warnings.filter((w) =>
					w.code.endsWith("_out_of_range"),
				),
			).toEqual(nullWarnings);
			const { problems } = await api.getJson<{ problems: Array<{ code: string }> }>(
				`/orchestrations/${id}/preflight`,
			);
			expect(problems.map((p) => p.code)).toEqual(
				expect.arrayContaining(["timeout_out_of_range", "queue_timeout_out_of_range"]),
			);
		});

		it("恢复出来的版本里没有这个问题时 warnings 里没有这两种", async () => {
			const id = await withOverLimitVersion();

			const res = await api.postEmpty(`/orchestrations/${id}/versions/2/restore`);

			expect(res.status).toBe(201);
			const body = (await res.json()) as WithWarnings;
			expect(body.warnings.filter((w) => w.code.endsWith("_out_of_range"))).toEqual([]);
		});

		it("恢复之后：改别处再检查、保存都是 400，写明是哪个节点的哪个字段；把它们改成合格的值才通过", async () => {
			const id = await withOverLimitVersion();
			await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
			const head = await api.getJson<{ number: number; document: ReturnType<typeof scenario> }>(
				`/orchestrations/${id}/head`,
			);
			const elsewhere = { ...head.document, default_agent: "agent-c" };

			const checked = await api.post(`/orchestrations/${id}/check`, { document: elsewhere });
			const saved = await api.post(`/orchestrations/${id}/versions`, {
				base_version: head.number,
				document: elsewhere,
			});

			for (const res of [checked, saved]) {
				expect(res.status).toBe(400);
				const message = (await errorOf(res)).message;
				expect(message).toContain(sentence("等槽位（a）", "timeout", TIMEOUT_TOO_LARGE));
				expect(message).toContain(sentence("等槽位（a）", "queue_timeout", QUEUE_TOO_LARGE));
			}
			const fixed = {
				...elsewhere,
				nodes: elsewhere.nodes.map((n) =>
					n.id === "a" ? { ...n, timeout: 60, queue_timeout: 120 } : n,
				),
			};
			expect((await api.post(`/orchestrations/${id}/check`, { document: fixed })).status).toBe(200);
			expect(
				(
					await api.post(`/orchestrations/${id}/versions`, {
						base_version: head.number,
						document: fixed,
					})
				).status,
			).toBe(201);
		});

		it("恢复出来的版本和库里已有的超限版本一样：触发前的预检阻断，触发被拒绝", async () => {
			const id = await withOverLimitVersion();
			await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);

			const { problems } = await api.getJson<{
				problems: Array<{ code: string; node_id?: string }>;
			}>(`/orchestrations/${id}/preflight`);

			expect(problems).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "timeout_out_of_range", node_id: "a" }),
					expect.objectContaining({ code: "queue_timeout_out_of_range", node_id: "a" }),
				]),
			);
			expect((await api.trigger(id)).status).toBe(400);
		});
	});

	describe("复制场景", () => {
		it("能复制：第 1 版原样带着超限的值，响应的 warnings 和恢复同一套，指到这个节点和字段", async () => {
			const id = await api.orchestrationWith(
				scenario({ display_name: "等槽位", timeout: 60, queue_timeout: 120 }),
			);
			await storeNodeField(cp.database.url, id, "a", "timeout", TIMEOUT_TOO_LARGE);
			await storeNodeField(cp.database.url, id, "a", "queue_timeout", QUEUE_TOO_LARGE);

			const res = await api.post(`/orchestrations/${id}/copy`, { name: "副本" });

			expect(res.status).toBe(201);
			const copied = (await res.json()) as WithWarnings & { id: string };
			expect(copied.head_version).toBe(1);
			expect(copied.warnings.filter((w) => w.code.endsWith("_out_of_range"))).toEqual([
				expect.objectContaining({
					code: "timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "timeout", TIMEOUT_TOO_LARGE),
				}),
				expect.objectContaining({
					code: "queue_timeout_out_of_range",
					node_id: "a",
					message: sentence("等槽位（a）", "queue_timeout", QUEUE_TOO_LARGE),
				}),
			]);
			const head = await api.getJson<{
				number: number;
				document: { nodes: Array<Record<string, unknown>> };
			}>(`/orchestrations/${copied.id}/head`);
			expect(head.number).toBe(1);
			expect(head.document.nodes[1]).toMatchObject({
				timeout: TIMEOUT_TOO_LARGE,
				queue_timeout: QUEUE_TOO_LARGE,
			});
			// 副本同样被预检挡住，要改成合格的值才能触发。
			expect((await api.trigger(copied.id)).status).toBe(400);
		});

		it("最新版本里带着已移除种类的节点（ADR 0028）：同样原样复制，响应的 warnings 里每个这样的节点一条 node_kind_removed，指到节点", async () => {
			await seedRemovedKindScenario(cp);

			const res = await api.post(`/orchestrations/${IDS.scenario}/copy`, { name: "副本" });

			expect(res.status).toBe(201);
			const copied = (await res.json()) as WithWarnings & { id: string };
			const removed = copied.warnings.filter((w) => w.code === "node_kind_removed");
			expect(removed.map((w) => w.node_id)).toEqual(["wait", "at", "notify"]);
			for (const w of removed) expect(w.message).toContain("已不再支持，不能运行");
			// 第 1 版里还是那三个节点：原样复制。
			const head = await api.getJson<{ document: { nodes: Array<{ id: string; kind: string }> } }>(
				`/orchestrations/${copied.id}/head`,
			);
			expect(head.document.nodes.map((n) => [n.id, n.kind])).toEqual([
				["entry", "entry"],
				["wait", "sleep"],
				["at", "timer"],
				["notify", "feishu_notify"],
			]);
		});

		it("没有问题的场景：warnings 里没有这两种；没有版本的场景：head_version 是 0，warnings 为空", async () => {
			const id = await api.orchestrationWith(scenario({ timeout: 60, queue_timeout: 120 }));
			const empty = await api.createOrchestration("还没有版本");

			const copied = (await (
				await api.post(`/orchestrations/${id}/copy`, { name: "副本" })
			).json()) as WithWarnings;
			const copiedEmpty = (await (
				await api.post(`/orchestrations/${empty}/copy`, { name: "空副本" })
			).json()) as WithWarnings;

			expect(copied.warnings.filter((w) => w.code.endsWith("_out_of_range"))).toEqual([]);
			expect(copiedEmpty.head_version).toBe(0);
			expect(copiedEmpty.warnings).toEqual([]);
		});
	});
});
