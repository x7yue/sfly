// sfly run show / run start --wait：排队中的节点写明在等谁（#457）。真实的 sfly 进程读测试控制面里的运行，
// 等的 Agent 不在线、或槽位被别的任务占满；写法和界面一致（apps/web/src/lib/copy.ts 的 QUEUE_WAIT）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { type SflyProcess, spawnSfly } from "./support/sfly-process.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** entry → a（排队超时 5 分钟，显示名称「准备环境」）。 */
const scenario = (agent: string) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			queue_timeout: 300,
			display_name: "准备环境",
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("sfly run show / run start --wait：排队中的节点在等什么", { timeout: 90_000 }, () => {
	const clock = new ManualClock();
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const processes: SflyProcess[] = [];
	let counter = 0;

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock, leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	}, 120_000);
	afterEach(async () => {
		for (const process of processes.splice(0)) process.kill();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
	});
	afterAll(async () => {
		await cp?.close();
	});

	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const start = (...args: string[]): SflyProcess => {
		const process = spawnSfly([...args, "--server", cp.httpUrl]);
		processes.push(process);
		return process;
	};
	const connect = async (name: string, slots = 4) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, slots });
		agents.push(agent);
		return agent;
	};
	/** 断开 Agent，等控制面把它记为离线（最后在线的时间就是这一刻，之后才推进时钟）。 */
	const goOffline = async (agent: FakeAgent, name: string) => {
		await agent.disconnect();
		agents.splice(agents.indexOf(agent), 1);
		await eventually(async () => {
			const list = (await (await cp.fetch("/agents")).json()) as {
				agents: Array<{ name: string; status: string }>;
			};
			expect(list.agents.find((a) => a.name === name)?.status).toBe("offline");
		});
	};

	it("run show：Agent 不在线时，排队中的节点写明等谁、离线多久、排了多久、多久后超时；--json 里是 queue_wait", async () => {
		const name = `offline-${++counter}`;
		await goOffline(await connect(name), name);
		clock.advance(2 * MINUTE);
		const runId = await api.triggerOk(await api.orchestrationWith(scenario(name), `离线 ${name}`));
		clock.advance(5 * SECOND);

		const text = await cli("run", "show", runId);
		expect(text.code, text.stderr).toBe(0);
		expect(text.stdout).toContain(
			[
				"排队中的节点：",
				`  main:a「准备环境」  等 ${name}（不在线，已离线 2m05s）· 排队 5.0s · 4m55s 后超时`,
			].join("\n"),
		);

		const json = await cli("run", "show", runId, "--json");
		const view = JSON.parse(json.stdout) as {
			chains: Array<{
				nodes: Array<{
					id: string;
					attempts: Array<{ queue_wait: { agent: string; state: string } | null }>;
				}>;
			}>;
		};
		const attempt = view.chains[0]?.nodes.find((n) => n.id === "a")?.attempts[0];
		expect(attempt?.queue_wait).toMatchObject({ agent: name, state: "offline" });
	});

	it("run start --wait：进度写明在等谁；Agent 上线、节点派发之后接着写后面的状态", async () => {
		const name = `waiting-${++counter}`;
		const gone = await connect(name);
		await goOffline(gone, name);
		await api.orchestrationWith(scenario(name), `等待 ${name}`);

		const waiting = start("run", "start", `等待 ${name}`, "--wait");
		await waiting.waitForStderr("main:a「准备环境」 排队中：等 ", 30_000);
		expect(waiting.stderr).toContain(`等 ${name}（不在线，已离线 `);
		expect(waiting.stderr).toContain("· 排队 0ms · 5m00s 后超时");

		// Agent 重新连上，节点派发出去：不再排队。
		const back = await connect(name);
		const task = await back.nextAssign({ timeoutMs: 30_000 });
		await back.succeed(task);
		const result = await waiting.exited;
		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("main:a「准备环境」 成功");
	});

	it("run show：Agent 在线、槽位占满时，写明占着槽位的任务", async () => {
		const name = `busy-${++counter}`;
		const agent = await connect(name, 1);
		const id = await api.orchestrationWith(scenario(name), `占满 ${name}`);
		await api.triggerOk(id);
		await agent.nextAssign({ timeoutMs: 30_000 });
		const waitingRun = await api.triggerOk(id);

		const text = await cli("run", "show", waitingRun);
		expect(text.code, text.stderr).toBe(0);
		expect(text.stdout).toContain(`等 ${name}（槽位占满，1 / 1）· 排队 `);
		expect(text.stdout).toContain(`占着槽位的任务：占满 ${name} 的 main:a「准备环境」`);
	});
});
