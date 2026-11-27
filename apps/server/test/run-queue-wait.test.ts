// 切入点 A（#457）：排队中的尝试在等什么。运行视图里排队中的尝试带 `queue_wait`：等的 Agent 是不是在线、
// 离线了多久（最后在线的时间）、还在准备环境、版本不一致，或者槽位被哪些任务占着，以及排队超时的时间；
// 都由控制面在读取的这一刻按派发的条件判断，页面和命令行不自己推算。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { seedForeignTask } from "./support/seed-foreign-task.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** entry → a（指定 Agent、排队超时 5 分钟）。 */
const scenario = (agent: string, extra: Record<string, unknown> = {}) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			queue_timeout: 300,
			display_name: "准备环境",
			...extra,
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("排队中的尝试在等什么", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	/** 停用、恢复 Agent 要登录的管理员（项目管理员的个人令牌）。 */
	let accounts: TestAccounts;
	let admin: Record<string, string>;

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		const boss = await accounts.user("boss");
		await accounts.member("default", boss, "project_admin");
		admin = bearer(await accounts.personalToken(boss));
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await accounts.close();
		await cp.close();
	});
	const setDisabled = async (name: string, disabled: boolean) => {
		const response = await cp.fetch(`/agents/${name}/${disabled ? "disable" : "enable"}`, {
			method: "POST",
			headers: admin,
		});
		expect(response.status).toBe(204);
	};

	const connect = async (hello: HelloInit, opts: { preparing?: boolean } = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello, opts);
		agents.push(agent);
		return agent;
	};
	/** 断开 Agent，等到控制面把它记为离线（最后在线的时间就是这一刻，之后才推进时钟）。 */
	const disconnect = async (agent: FakeAgent, name = "agent-a") => {
		await agent.disconnect();
		agents.splice(agents.indexOf(agent), 1);
		await eventually(async () => {
			const list = (await (await cp.fetch("/agents")).json()) as {
				agents: Array<{ name: string; status: string }>;
			};
			expect(list.agents.find((a) => a.name === name)?.status).toBe("offline");
		});
	};
	/** 节点 a 的最后一次尝试。 */
	const attemptOf = async (runId: string) => (await api.node(runId, "a")).attempts.at(-1);

	it("Agent 不在线：写明等的是哪台、最后在线的时间和排队超时的时间", async () => {
		const gone = await connect({ name: "agent-a" });
		clock.advance(30 * SECOND);
		const lastSeen = clock.now().toISOString();
		await disconnect(gone);
		clock.advance(2 * MINUTE);
		const queuedAt = clock.now();
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));

		const attempt = await attemptOf(runId);
		expect(attempt?.status).toBe("queued");
		expect(attempt?.queue_wait).toEqual({
			agent: "agent-a",
			now: clock.now().toISOString(),
			state: "offline",
			since: lastSeen,
			expires_at: new Date(queuedAt.getTime() + 5 * MINUTE).toISOString(),
			slots: null,
			holders: [],
			other_project_holders: 0,
		});
	});

	it("Agent 被管理员停用：写「已停用」和停用的时间（不写离线）；恢复之后照常（#492）", async () => {
		// 停用之后触发会被预检拒绝（引用了停用的 Agent）：这是触发时还没停用、排着队的运行。
		const gone = await connect({ name: "agent-a" });
		await disconnect(gone);
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));
		expect((await attemptOf(runId))?.queue_wait?.state).toBe("offline");

		clock.advance(30 * SECOND);
		await setDisabled("agent-a", true);
		const disabledAt = clock.now().toISOString();
		clock.advance(2 * MINUTE);

		const wait = (await attemptOf(runId))?.queue_wait;
		expect(wait).toEqual({
			agent: "agent-a",
			now: clock.now().toISOString(),
			state: "disabled",
			since: disabledAt,
			expires_at: expect.any(String),
			slots: null,
			holders: [],
			other_project_holders: 0,
		});

		// 恢复之后照常：Agent 重新连上就会接这个排着的任务。
		await setDisabled("agent-a", false);
		const back = await connect({ name: "agent-a" });
		await back.nextAssign();
	});

	it("已停用排在连接状态之前：停用到连接真的关掉之间还在线的 Agent，槽位占满也写已停用", async () => {
		const agent = await connect({ name: "agent-a", slots: 1 });
		const id = await api.orchestrationWith(scenario("agent-a"));
		await api.triggerOk(id);
		await agent.nextAssign();
		const waitingRun = await api.triggerOk(id);
		expect((await attemptOf(waitingRun))?.queue_wait?.state).toBe("slots_full");

		// 只写库、不关连接：造出「已经停用、连接还没关」的那一瞬。
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			await db.query("update agents set disabled_at = $1 where name = 'agent-a'", [clock.now()]);
		} finally {
			await db.end();
		}
		const wait = (await attemptOf(waitingRun))?.queue_wait;
		expect(wait).toMatchObject({
			state: "disabled",
			since: clock.now().toISOString(),
			slots: null,
			holders: [],
		});
	});

	it("排队超时的时间随节点的 queue_timeout 走", async () => {
		await disconnect(await connect({ name: "agent-a" }));
		const runId = await api.triggerOk(
			await api.orchestrationWith(scenario("agent-a", { queue_timeout: 60 })),
		);
		const attempt = await attemptOf(runId);
		expect(attempt?.queue_wait?.expires_at).toBe(
			new Date(Date.parse(attempt?.queued_at ?? "") + MINUTE).toISOString(),
		);
	});

	it("Agent 在线但还在准备环境：写明开始准备的时间", async () => {
		const welcomedAt = clock.now().toISOString();
		await connect({ name: "agent-a" }, { preparing: true });
		clock.advance(90 * SECOND);
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));

		const wait = (await attemptOf(runId))?.queue_wait;
		expect(wait).toMatchObject({ agent: "agent-a", state: "preparing", since: welcomedAt });
		expect(wait?.holders).toEqual([]);
	});

	it("Agent 版本和控制面不一致：不派新任务，写明原因", async () => {
		await connect({ name: "agent-a", agentVersion: "0.0.1" });
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));

		const wait = (await attemptOf(runId))?.queue_wait;
		expect(wait).toMatchObject({ agent: "agent-a", state: "version_mismatch", since: null });
	});

	it("在线、槽位占满：写明占着槽位的任务（场景、运行、节点、尝试），派发之后不再有 queue_wait", async () => {
		const agent = await connect({ name: "agent-a", slots: 1 });
		const id = await api.orchestrationWith(scenario("agent-a"));
		const holderRun = await api.triggerOk(id);
		const holding = await agent.nextAssign();
		clock.advance(10 * SECOND);
		const waitingRun = await api.triggerOk(id);

		const waiting = await attemptOf(waitingRun);
		expect(waiting?.status).toBe("queued");
		expect(waiting?.queue_wait).toMatchObject({
			agent: "agent-a",
			state: "slots_full",
			since: null,
			slots: 1,
		});
		expect(waiting?.queue_wait?.holders).toEqual([
			{
				run_id: holderRun,
				orchestration_id: id,
				orchestration_name: expect.any(String),
				node_id: "a",
				display_name: "准备环境",
				chain_name: null,
				attempt: 1,
				status: "running",
				started_at: expect.any(String),
			},
		]);
		expect(waiting?.queue_wait?.other_project_holders).toBe(0);
		// 占着槽位的那个尝试不是排队中的，没有 queue_wait。
		expect((await attemptOf(holderRun))?.queue_wait).toBeNull();

		// 槽位释放，排队的任务派发出去：它不再排队，没有 queue_wait。
		await agent.succeed(holding);
		const next = await agent.nextAssign();
		expect(next.nodeId).toBe("a");
		await eventually(async () => {
			const after = await attemptOf(waitingRun);
			expect(after?.status).toBe("running");
			expect(after?.queue_wait).toBeNull();
		});
	});

	it("槽位被别的项目的任务占着：只给个数，不给那个项目的场景名、运行编号和节点名", async () => {
		const agent = await connect({ name: "agent-a", slots: 2 });
		const id = await api.orchestrationWith(scenario("agent-a"));
		const mine = await api.triggerOk(id);
		await agent.nextAssign();
		// 另一个项目的任务占着第二个槽位（直接写库：Agent 归属项目之前，同一台 Agent 上本来不会有别的项目的任务）。
		const foreign = await seedForeignTask(cp, {
			project: "jia",
			agent: "agent-a",
			scenarioName: "甲的秘密场景",
		});
		clock.advance(10 * SECOND);
		const waitingRun = await api.triggerOk(id);

		const wait = (await attemptOf(waitingRun))?.queue_wait;
		expect(wait).toMatchObject({ state: "slots_full", slots: 2, other_project_holders: 1 });
		// 读者的项目里占着槽位的只有自己的那一个。
		expect(wait?.holders.map((h) => h.run_id)).toEqual([mine]);
		// 别的项目的场景名、运行编号、节点名一个字都不在响应里。
		const body = JSON.stringify(await (await cp.fetch(`/runs/${waitingRun}`)).json());
		expect(body).not.toContain("甲的秘密场景");
		expect(body).not.toContain(foreign.run);
		expect(body).not.toContain("别人的节点");
	});

	it("运行视图的推送（SSE）也带 queue_wait", async () => {
		await disconnect(await connect({ name: "agent-a" }));
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));
		const sse = await SseClient.open(cp, `/runs/${runId}/events`);
		try {
			const event = await sse.next("run");
			const view = event.data as {
				chains: Array<{
					nodes: Array<{
						node_id: string;
						attempts: Array<{ queue_wait: { state: string } | null }>;
					}>;
				}>;
			};
			const attempt = view.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0];
			expect(attempt?.queue_wait?.state).toBe("offline");
		} finally {
			sse.close();
		}
	});
});
