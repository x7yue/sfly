// 节点类型声明自己的默认超时（#476）：派发给 Agent 的超时按「场景里这个节点写的 → 节点类型声明的 → 平台的 1 小时」取，
// 超时失败的错误信息在用了平台默认时补一句怎么办。HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
// 取值顺序的各个来源（含开发版本）看下发给 Agent 的 `timeoutSeconds`；错误信息看节点的 error.message。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, ErrorKind, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 平台默认的超时：1 小时（docs/SEMANTICS.md §3.3）。 */
const PLATFORM_SECONDS = 3600;
const HINT =
	"节点和节点类型都没有设置超时，用的是平台默认的 1 小时；长时间运行的节点在 `@node(timeout=…)` 里声明，或在场景里给这个节点设超时。";
const AGENT_TIMEOUT_MESSAGE = "任务执行超过 3600 秒，已终止进程树";

const devMetadata = (timeout: unknown) => ({
	name: "devpkg",
	version: "dev",
	requires_python: ">=3.10",
	nodes: [
		{
			name: "job",
			title: "job",
			entry: "devpkg:job",
			...(timeout === undefined ? {} : { timeout }),
			inputs: { type: "object", properties: {}, required: [] },
			outputs: { type: "object", properties: {} },
		},
	],
});

describe("节点类型声明的默认超时", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (init: Pick<HelloInit, "devPackages"> = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", ...init });
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		// 1.0.0 的节点类型都没有声明超时；2.0.0 里 long 声明了 12 小时，short 没有。
		await publishPackage(cp, "limits", "1.0.0", { long: ["v"], short: ["v"] });
		await publishPackage(cp, "limits", "2.0.0", {
			long: { outputs: ["v"], timeout: 43_200 },
			short: ["v"],
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	/** 单个包节点的场景；`version` 是锁定的版本，`timeout` 是场景里这个节点写的超时。 */
	const scenario = (
		node: string,
		version: string,
		{ timeout, pkg = "limits", retries }: { timeout?: number; pkg?: string; retries?: number } = {},
	) => ({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{
				id: "a",
				kind: "package",
				package: pkg,
				node,
				inputs: {},
				...(timeout === undefined ? {} : { timeout }),
				...(retries === undefined ? {} : { retries }),
			},
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { [pkg]: version },
	});
	/** 触发场景，返回 Agent 收到的第一个任务（派发给 Agent 的内容）。 */
	const dispatched = async (agent: FakeAgent, document: unknown): Promise<AssignedTask> => {
		const id = await api.orchestrationWith(document);
		await api.triggerOk(id);
		return agent.nextAssign();
	};

	describe("下发给 Agent 的超时", () => {
		it("场景里这个节点写了超时：用它，盖过节点类型声明的", async () => {
			const agent = await connect();
			const task = await dispatched(agent, scenario("long", "2.0.0", { timeout: 120 }));
			expect(task.timeoutSeconds).toBe(120);
		});

		it("场景里没写、节点类型声明了：用节点类型声明的", async () => {
			const agent = await connect();
			const task = await dispatched(agent, scenario("long", "2.0.0"));
			expect(task.timeoutSeconds).toBe(43_200);
		});

		it("都没有：平台默认的 1 小时，和没有这个功能时一样", async () => {
			const agent = await connect();
			const task = await dispatched(agent, scenario("short", "2.0.0"));
			expect(task.timeoutSeconds).toBe(PLATFORM_SECONDS);
		});

		it("节点包没有声明过任何超时（旧版本）：派发的超时不变", async () => {
			const agent = await connect();
			const none = await dispatched(agent, scenario("long", "1.0.0"));
			expect(none.timeoutSeconds).toBe(PLATFORM_SECONDS);
			await agent.succeed(none, { v: 1 });
			const written = await dispatched(agent, scenario("long", "1.0.0", { timeout: 90 }));
			expect(written.timeoutSeconds).toBe(90);
		});

		it("场景锁定旧版本时超时不变；升级到声明了超时的版本后，没在节点上写超时的节点跟着新声明走", async () => {
			const agent = await connect();
			const id = await api.orchestrationWith(scenario("long", "1.0.0"));
			await api.triggerOk(id);
			const locked = await agent.nextAssign();
			expect(locked.timeoutSeconds).toBe(PLATFORM_SECONDS);
			await agent.succeed(locked, { v: 1 });

			await api.saveVersion(id, scenario("long", "2.0.0"));
			await api.triggerOk(id);
			const upgraded = await agent.nextAssign();
			expect(upgraded.timeoutSeconds).toBe(43_200);
		});

		it("开发版本：取节点所在 Agent 上报的元信息里声明的超时", async () => {
			const agent = await connect({
				devPackages: [
					{
						name: "devpkg",
						source: "/src/devpkg",
						metadataJson: JSON.stringify(devMetadata(900)),
					},
				],
			});
			const declared = await dispatched(agent, scenario("job", "dev", { pkg: "devpkg" }));
			expect(declared.timeoutSeconds).toBe(900);
			await agent.succeed(declared, {});
			const written = await dispatched(
				agent,
				scenario("job", "dev", { pkg: "devpkg", timeout: 60 }),
			);
			expect(written.timeoutSeconds).toBe(60);
		});

		it.each([
			["不是数字", "soon"],
			["不是整数", 1.5],
			["不是正数", 0],
			["是负数", -5],
		])("开发版本的元信息没经过发布校验：声明的超时%s时忽略它，用平台默认的", async (_, bad) => {
			const agent = await connect({
				devPackages: [
					{
						name: "devpkg",
						source: "/src/devpkg",
						metadataJson: JSON.stringify(devMetadata(bad)),
					},
				],
			});
			const task = await dispatched(agent, scenario("job", "dev", { pkg: "devpkg" }));
			expect(task.timeoutSeconds).toBe(PLATFORM_SECONDS);
		});
	});

	describe("超时失败的错误信息", () => {
		/** 派发、让 Agent 以超时失败，返回节点上记的错误信息。 */
		const timedOut = async (agent: FakeAgent, document: unknown): Promise<string> => {
			const id = await api.orchestrationWith(document);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), AGENT_TIMEOUT_MESSAGE, ErrorKind.TIMEOUT);
			let message = "";
			await eventually(async () => {
				const node = await api.node(runId, "a");
				expect(node.status).toBe("failed");
				expect(node.error?.kind).toBe("timeout");
				message = node.error?.message ?? "";
			});
			return message;
		};

		it("用的是平台默认：Agent 报的原文后面补一句怎么办（另起一行，失败原因的那一行不变）", async () => {
			const agent = await connect();
			expect(await timedOut(agent, scenario("short", "2.0.0"))).toBe(
				`${AGENT_TIMEOUT_MESSAGE}\n${HINT}`,
			);
		});

		it("节点类型声明了超时：不补", async () => {
			const agent = await connect();
			expect(await timedOut(agent, scenario("long", "2.0.0"))).toBe(AGENT_TIMEOUT_MESSAGE);
		});

		it("场景里这个节点写了超时（哪怕和平台默认的数一样）：不补", async () => {
			const agent = await connect();
			const document = scenario("short", "2.0.0", { timeout: PLATFORM_SECONDS });
			expect(await timedOut(agent, document)).toBe(AGENT_TIMEOUT_MESSAGE);
		});

		it("开发版本：节点类型声明了超时不补，没声明的补", async () => {
			const dev = (timeout?: number) => ({
				name: "devpkg",
				source: "/src/devpkg",
				metadataJson: JSON.stringify(devMetadata(timeout)),
			});
			const declared = await connect({ devPackages: [dev(900)] });
			expect(await timedOut(declared, scenario("job", "dev", { pkg: "devpkg" }))).toBe(
				AGENT_TIMEOUT_MESSAGE,
			);
			await declared.disconnect();
			agents.splice(agents.indexOf(declared), 1);
			const plain = await connect({ devPackages: [dev()] });
			expect(await timedOut(plain, scenario("job", "dev", { pkg: "devpkg" }))).toBe(
				`${AGENT_TIMEOUT_MESSAGE}\n${HINT}`,
			);
		});

		it("锁定的节点包版本被删掉、找不到节点类型：不知道它有没有声明超时，不补（只会少说，不说错）", async () => {
			const agent = await connect();
			const id = await api.orchestrationWith(scenario("short", "2.0.0"));
			const runId = await api.triggerOk(id);
			const task = await agent.nextAssign();
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query("delete from node_packages where name = 'limits' and version = '2.0.0'");
			} finally {
				await client.end();
			}

			await agent.fail(task, AGENT_TIMEOUT_MESSAGE, ErrorKind.TIMEOUT);

			await eventually(async () => {
				const node = await api.node(runId, "a");
				expect(node.status).toBe("failed");
				expect(node.error).toEqual({
					kind: "timeout",
					message: AGENT_TIMEOUT_MESSAGE,
					location: null,
				});
			});
		});

		it("不是超时的失败：不补", async () => {
			const agent = await connect();
			const id = await api.orchestrationWith(scenario("short", "2.0.0"));
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "节点自己出错", ErrorKind.NODE_ERROR);
			await eventually(async () =>
				expect((await api.node(runId, "a")).error?.message).toBe("节点自己出错"),
			);
		});
	});

	describe("场景里节点的超时超过上限（派发给 Agent 的超时是 uint32）", () => {
		const TOO_LARGE = 5_000_000_000;
		const MESSAGE = (id: string) =>
			`节点 ${id}：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 ${TOO_LARGE}`;

		it("保存时被拒绝（400），错误信息写明是哪个节点、范围、实际是多少", async () => {
			const id = await api.createOrchestration("超限");
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 0,
				document: scenario("short", "2.0.0", { timeout: TOO_LARGE }),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.message).toContain(MESSAGE("a"));
		});

		/** 绕过保存校验把已保存的版本里节点 a 的超时改成超限的值：模拟升级前保存的版本。 */
		const tamper = async (databaseUrl: string, orchestrationId: string) => {
			const client = new pg.Client({ connectionString: databaseUrl });
			await client.connect();
			try {
				const { rows } = await client.query<{
					id: string;
					document: { nodes: Array<{ id: string }> };
				}>("select id, document from orchestration_versions where orchestration_id = $1", [
					orchestrationId,
				]);
				for (const row of rows) {
					const node = row.document.nodes.find((n) => n.id === "a") as { timeout?: number };
					node.timeout = TOO_LARGE;
					await client.query("update orchestration_versions set document = $1 where id = $2", [
						JSON.stringify(row.document),
						row.id,
					]);
				}
			} finally {
				await client.end();
			}
		};

		it("升级前保存的版本里已经有超限的值：触发前的预检阻断，指到这个节点", async () => {
			const id = await api.orchestrationWith(scenario("short", "2.0.0", { timeout: 120 }));
			await connect(); // 触发要求 Agent 注册过
			await tamper(cp.database.url, id);
			await cp.restart(); // 版本文档在控制面里缓存过：重启后重新读

			const { problems } = await api.getJson<{
				problems: Array<{ code: string; node_id?: string; message: string }>;
			}>(`/orchestrations/${id}/preflight`);
			expect(problems).toContainEqual(
				expect.objectContaining({
					code: "timeout_out_of_range",
					node_id: "a",
					message: MESSAGE("a"),
				}),
			);
			expect((await api.trigger(id)).status).toBe(400);
		});

		it("已经触发、还在排队的任务，版本里的超时是超限的值：这个任务在被标成已派发之前以配置错误失败（不重试），同一批派发里排在它前面和后面的任务都照常收到", async () => {
			// 设了重试：配置错误不按重试配置重试（只有一次尝试），这条断言才有意义。
			const bad = await api.orchestrationWith(
				scenario("short", "2.0.0", { timeout: 120, retries: 2 }),
			);
			const before = await api.orchestrationWith(scenario("short", "2.0.0", { timeout: 60 }));
			const after = await api.orchestrationWith(scenario("short", "2.0.0", { timeout: 90 }));
			// Agent 注册过但不在线：三个运行的任务按触发的先后排队（前、超限的、后），Agent 连上时在同一批里派发。
			await (await connect()).disconnect();
			agents.length = 0;
			const beforeRun = await api.triggerOk(before);
			const badRun = await api.triggerOk(bad);
			const afterRun = await api.triggerOk(after);
			await tamper(cp.database.url, bad);
			await cp.restart();

			const agent = await connect();
			const first = await agent.nextAssign();
			const second = await agent.nextAssign();

			// 收到的是前后两个运行的任务（同一批）；超限的那个没有发给 Agent，连接也没有被拆掉。
			expect([first.timeoutSeconds, second.timeoutSeconds]).toEqual([60, 90]);
			await eventually(async () => {
				const node = await api.node(badRun, "a");
				expect(node.status).toBe("failed");
				expect(node.error).toEqual({ kind: "config_error", message: MESSAGE("a"), location: null });
			});
			await agent.succeed(first, { v: 1 });
			await agent.succeed(second, { v: 1 });
			await eventually(async () => {
				expect((await api.run(beforeRun)).status).toBe("success");
				expect((await api.run(afterRun)).status).toBe("success");
			});
			// 配置错误不重试：只有一次尝试，也没有再派发。
			await agent.expectNoAssign();
			const attempts = (await api.node(badRun, "a")).attempts;
			expect(attempts.map((a) => [a.attempt, a.status, a.error?.kind])).toEqual([
				[1, "failed", "config_error"],
			]);
			// 超限的任务没有被标成已派发：它没有开始时间。
			expect((await api.node(badRun, "a")).attempts[0]?.started_at ?? null).toBeNull();
		});
	});
});
