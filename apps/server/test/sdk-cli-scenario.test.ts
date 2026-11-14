// sfly scenario list / show：真实的 sfly 进程查询测试控制面里的场景。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SAVED_AT = "2026-03-04T05:06:07.000Z";

const paymentDocument = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "host", type: "string", required: true, description: "目标主机，不带端口" },
				{ name: "retries", type: "number", default: 3 },
				{
					name: "token",
					type: "string",
					secret: true,
					default: "hunter2",
					description: "访问令牌",
				},
			],
		},
		{ id: "deploy", kind: "package", package: "stub", node: "echo", agent: "agent-b" },
		{ id: "spawn", kind: "async" },
		{ id: "pause", kind: "sleep", duration: "5s" },
		{ id: "stop", kind: "stop_subflow", subflow: "sub" },
		{
			id: "sub",
			kind: "subflow_entry",
			name: "report",
			params: [{ name: "run", type: "string", required: true, description: "上游运行 ID" }],
		},
		{ id: "send", kind: "package", package: "stub", node: "echo" },
		{ id: "loose", kind: "timer", at: "10:00:00" },
	],
	edges: [
		{ from: "entry", to: "deploy", kind: "chain" },
		{ from: "deploy", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "pause", kind: "chain" },
		{ from: "pause", to: "stop", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "send", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};

const simpleDocument = {
	default_agent: "agent-c",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

interface ListedScenario {
	id: string;
	name: string;
	description: string;
	head_version: number;
	default_agent: string | null;
}

describe("sfly scenario list / show → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const clock = new ManualClock(SAVED_AT);
	const ids: Record<string, string> = {};
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	const createScenario = async (
		name: string,
		document?: unknown,
		description = "",
	): Promise<string> => {
		const res = await api.post("/orchestrations", { name, description });
		const { id } = (await res.json()) as { id: string };
		if (document) await api.saveVersion(id, document);
		clock.advance(1000);
		return id;
	};

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		ids.payment = await createScenario("支付回归", paymentDocument, "支付链路的回归场景");
		ids.empty = await createScenario("空场景");
		ids.twinA = await createScenario("重名", simpleDocument);
		ids.twinB = await createScenario("重名", simpleDocument);
		ids.old = await createScenario("旧场景", simpleDocument);
		expect((await api.postEmpty(`/orchestrations/${ids.old}/archive`)).status).toBe(200);
		ids.archivedTwin = await createScenario("只在归档里", simpleDocument);
		expect((await api.postEmpty(`/orchestrations/${ids.archivedTwin}/archive`)).status).toBe(200);
		ids.live = await createScenario("旧场景", simpleDocument);
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
	});

	describe("list", () => {
		it("文本输出：名称、id、最新版本号、默认 Agent，新建的在前，不含已归档的场景", async () => {
			const result = await cli("scenario", "list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					"名称      id                                    最新版本  默认 Agent",
					`旧场景    ${ids.live}  1         agent-c`,
					`重名      ${ids.twinB}  1         agent-c`,
					`重名      ${ids.twinA}  1         agent-c`,
					`空场景    ${ids.empty}  -         -`,
					`支付回归  ${ids.payment}  1         agent-a`,
					"",
				].join("\n"),
			);
		});

		it("--json 输出数组", async () => {
			const result = await cli("scenario", "list", "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			const rows = JSON.parse(result.stdout) as ListedScenario[];
			expect(rows.map((r) => r.id)).toEqual([
				ids.live,
				ids.twinB,
				ids.twinA,
				ids.empty,
				ids.payment,
			]);
			expect(rows.at(-1)).toEqual({
				id: ids.payment,
				name: "支付回归",
				description: "支付链路的回归场景",
				head_version: 1,
				default_agent: "agent-a",
				updated_at: expect.any(String),
			});
			expect(rows.find((r) => r.id === ids.empty)).toMatchObject({
				head_version: 0,
				default_agent: null,
			});
		});

		it("按名称搜索、按 Agent 筛选", async () => {
			const searched = JSON.parse(
				(await cli("scenario", "list", "--json", "--search", "支付")).stdout,
			);
			expect(searched.map((r: ListedScenario) => r.id)).toEqual([ids.payment]);

			const byAgent = JSON.parse(
				(await cli("scenario", "list", "--json", "--agent", "agent-b")).stdout,
			);
			expect(byAgent.map((r: ListedScenario) => r.id)).toEqual([ids.payment]);

			const none = await cli("scenario", "list", "--search", "不存在的场景");
			expect(none.code, none.stderr).toBe(0);
			expect(none.stdout.trim()).toBe("没有符合条件的场景");
		});

		it("超过 --limit 时文本的最后一行写明还有多少条、怎么看更多", async () => {
			const text = await cli("scenario", "list", "--limit", "2");
			expect(text.code, text.stderr).toBe(0);
			const lines = text.stdout.trimEnd().split("\n");
			expect(lines).toHaveLength(4);
			expect(lines.at(-1)).toBe("还有 3 个场景没有显示（共 5 个场景），加 --limit 5 查看全部");

			const all = await cli("scenario", "list", "--limit", "5");
			expect(all.stdout).not.toContain("没有显示");
		});

		it("--json 时 stdout 只有被截断后的数组，提示写到 stderr", async () => {
			const json = await cli("scenario", "list", "--json", "--limit", "2");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toHaveLength(2);
			expect(json.stderr.trim()).toBe(
				"还有 3 个场景没有显示（共 5 个场景），加 --limit 5 查看全部",
			);
		});

		it("--limit 不是正整数时报参数错误", async () => {
			const result = await cli("scenario", "list", "--limit", "0");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--limit");
		});
	});

	describe("show", () => {
		const expectedText = (id: string) =>
			[
				`场景 支付回归（${id}）`,
				"说明：支付链路的回归场景",
				`最新版本：1，tester 保存于 ${SAVED_AT}`,
				"默认 Agent：agent-a",
				"",
				"主链",
				"  入口参数：",
				"    参数     类型    说明",
				"    host     string  目标主机，不带端口，必填",
				"    retries  number  默认 3",
				"    token    string  访问令牌，secret",
				"  节点：",
				"    节点    节点类型                  包版本  Agent",
				"    deploy  stub/echo                 1.0.0   agent-b",
				"    spawn   异步任务 → 子流程 report  -       -",
				"    pause   Sleep                     -       -",
				"    stop    停止子流程 report         -       -",
				"",
				"子流程 report（入口 sub，由 spawn 触发）",
				"  入口参数：",
				"    参数  类型    说明",
				"    run   string  上游运行 ID，必填",
				"  节点：",
				"    节点  节点类型   包版本  Agent",
				"    send  stub/echo  1.0.0   agent-a",
				"",
				"没有连进任何链的节点：",
				"  节点   节点类型  包版本  Agent",
				"  loose  定时      -       -",
			].join("\n");

		it("文本输出：入口参数、主链和子流程上的节点（类型、锁定的包版本、Agent）、默认 Agent", async () => {
			const result = await cli("scenario", "show", ids.payment as string);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(`${expectedText(ids.payment as string)}\n`);
		});

		it("--json 输出对象；secret 参数不输出默认值", async () => {
			const result = await cli("scenario", "show", ids.payment as string, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).not.toContain("hunter2");
			expect(JSON.parse(result.stdout)).toEqual({
				id: ids.payment,
				name: "支付回归",
				description: "支付链路的回归场景",
				archived: false,
				head_version: 1,
				version: { number: 1, author: "tester", created_at: SAVED_AT },
				default_agent: "agent-a",
				params: [
					{
						name: "host",
						type: "string",
						required: true,
						secret: false,
						description: "目标主机，不带端口",
					},
					{ name: "retries", type: "number", required: false, secret: false, default: 3 },
					{
						name: "token",
						type: "string",
						required: false,
						secret: true,
						description: "访问令牌",
					},
				],
				nodes: [
					{
						id: "deploy",
						kind: "package",
						always: false,
						package: "stub",
						node: "echo",
						package_version: "1.0.0",
						agent: "agent-b",
					},
					{ id: "spawn", kind: "async", always: false, subflow: "report" },
					{ id: "pause", kind: "sleep", always: false },
					{ id: "stop", kind: "stop_subflow", always: false, subflow: "report" },
				],
				subflows: [
					{
						name: "report",
						entry: "sub",
						triggered_by: "spawn",
						params: [
							{
								name: "run",
								type: "string",
								required: true,
								secret: false,
								description: "上游运行 ID",
							},
						],
						nodes: [
							{
								id: "send",
								kind: "package",
								always: false,
								package: "stub",
								node: "echo",
								package_version: "1.0.0",
								agent: "agent-a",
							},
						],
					},
				],
				unlinked: [{ id: "loose", kind: "timer", always: false }],
			});
		});

		it("还没有保存过版本的场景显示初始文档", async () => {
			const result = await cli("scenario", "show", ids.empty as string);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("最新版本：还没有保存过版本（下面是初始文档）");
			expect(result.stdout).toContain("默认 Agent：未设置");

			const json = JSON.parse((await cli("scenario", "show", "空场景", "--json")).stdout);
			expect(json).toMatchObject({ head_version: 0, version: null, params: [], nodes: [] });
		});

		it("名称唯一时按名称找到，和按 id 找到的是同一个场景", async () => {
			const byName = await cli("scenario", "show", "支付回归");
			expect(byName.code, byName.stderr).toBe(0);
			expect(byName.stdout).toBe(`${expectedText(ids.payment as string)}\n`);
		});

		it("名称对应多个场景时报错并列出候选的 id 和最新版本号", async () => {
			const text = await cli("scenario", "show", "重名");
			expect(text.code).toBe(2);
			expect(text.stdout).toBe("");
			expect(text.stderr).toBe(
				[
					"错误：名称「重名」对应 2 个场景，用 id 指定其中一个：",
					`  ${ids.twinB}  最新版本 1`,
					`  ${ids.twinA}  最新版本 1`,
					`下一步：sfly scenario show ${ids.twinB}`,
					"",
				].join("\n"),
			);

			const json = await cli("scenario", "show", "重名", "--json");
			expect(json.code).toBe(2);
			const { error } = JSON.parse(json.stderr) as {
				error: { code: string; message: string; next: string };
			};
			expect(error.code).toBe("scenario_ambiguous");
			expect(error.message).toContain(ids.twinA);
			expect(error.message).toContain(ids.twinB);
			expect(error.next).toBe(`sfly scenario show ${ids.twinB}`);

			// 用候选里的 id 就能指定。
			const picked = await cli("scenario", "show", ids.twinA as string, "--json");
			expect(picked.code, picked.stderr).toBe(0);
			expect(JSON.parse(picked.stdout).id).toBe(ids.twinA);
		});

		it("已归档的场景不参与名称匹配：同名的未归档场景是唯一的匹配", async () => {
			const result = await cli("scenario", "show", "旧场景", "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout).id).toBe(ids.live);
		});

		it("只有已归档的场景用这个名称时按名称找不到，按 id 仍然能看", async () => {
			const missing = await cli("scenario", "show", "只在归档里");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有 id 或名称是「只在归档里」的场景");
			expect(missing.stderr).toContain("另有 2 个已归档的场景，不参与名称匹配");
			expect(missing.stderr).toContain("下一步：sfly scenario list --search '只在归档里'");

			const byId = await cli("scenario", "show", ids.archivedTwin as string, "--json");
			expect(byId.code, byId.stderr).toBe(0);
			expect(JSON.parse(byId.stdout)).toMatchObject({ name: "只在归档里", archived: true });
		});

		it("id 或名称都不对应场景时报错，--json 时错误也是 JSON", async () => {
			const unknownId = "00000000-0000-4000-8000-000000000000";
			const text = await cli("scenario", "show", unknownId);
			expect(text.code).toBe(2);
			expect(text.stderr.split("\n")[0]).toContain(`没有 id 或名称是「${unknownId}」的场景`);

			const json = await cli("scenario", "show", "不存在的场景", "--json");
			expect(json.code).toBe(2);
			expect(json.stdout).toBe("");
			expect(JSON.parse(json.stderr)).toEqual({
				error: {
					code: "scenario_not_found",
					message: expect.stringContaining("没有 id 或名称是「不存在的场景」的场景"),
					next: "sfly scenario list --search '不存在的场景'",
				},
			});
		});
	});
});

describe("sfly scenario list 的默认条数上限", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane({ clock: new ManualClock(SAVED_AT) });
		const api = new ApiClient(cp);
		for (let i = 1; i <= 52; i++) {
			expect((await api.post("/orchestrations", { name: `场景-${i}` })).status).toBe(201);
		}
	}, 120_000);
	afterAll(async () => {
		await cp?.close();
	});

	it("没有 --limit 时最多输出 50 条，最后一行提示还有 2 条", async () => {
		const result = await sfly(["scenario", "list", "--server", cp.httpUrl]);
		expect(result.code, result.stderr).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1 + 50 + 1);
		expect(lines.at(-1)).toBe("还有 2 个场景没有显示（共 52 个场景），加 --limit 52 查看全部");

		const all = await sfly(["scenario", "list", "--json", "--limit", "52", "--server", cp.httpUrl]);
		expect(JSON.parse(all.stdout)).toHaveLength(52);
	});
});
