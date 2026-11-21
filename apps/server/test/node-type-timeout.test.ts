// 节点类型声明自己的默认超时（#476）：派发给 Agent 的超时按「场景里这个节点写的 → 节点类型声明的 → 平台的 1 小时」取，
// 超时失败的错误信息在用了平台默认时补一句怎么办。HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
// 取值顺序的各个来源（含开发版本）看下发给 Agent 的 `timeoutSeconds`；错误信息看节点的 error.message。
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
		{ timeout, pkg = "limits" }: { timeout?: number; pkg?: string } = {},
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
});
