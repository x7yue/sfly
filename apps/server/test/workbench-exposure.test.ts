// 工作台够得着的项目外 Agent（#498）：控制面定期请部署者为工作台配置的探测服务（出网名单容器上的，SFLY_FIREWALL_PROBES）只试连接
// 别的项目里在线 Agent 的能力端口，结果带进就绪状态（助手页、会话页告警）。真实控制面和数据库，进程内的假助手服务，假 Agent 当工作台和
// 别的项目的 Agent，探测换成假的（真的探测服务在 deploy/workbench/firewall.py，scripts/tests 和 compose 冒烟里测）。
import { sessionsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeConfig } from "../src/sessions/probe-config.js";
import {
	EXPOSURE_RECHECK_MS,
	PROBE_BATCH,
	type ProbeResult,
	probeAll,
	type WorkbenchProbe,
} from "../src/sessions/workbench-exposure.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const PROBE_ADDRESS = "sfly-workbench:47124";

describe("工作台探测项目外 Agent 的能力端口", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let api: ApiClient;
	let bossToken: string;
	const agents = new Map<string, FakeAgent>();
	/** 每次探测（发到哪、目标）；回什么由 `reply` 决定，抛错就是这一轮没测成。 */
	let calls: { address: string; targets: string[] }[];
	let reply: (targets: string[]) => ProbeResult[] | Promise<ProbeResult[]>;

	const connect = async (name: string, port: number, address: string, project = "default") => {
		const { token } = await cp.current.agentCredentials.issue(project as never, name);
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name, peer: { port, publicAddress: address }, token },
			{ clock: cp.clock },
		);
		agents.set(name, agent);
		return agent;
	};
	const disconnect = async (name: string) => {
		await agents.get(name)?.disconnect();
		agents.delete(name);
	};
	// 按契约的 schema 解析（read-only-routes.test.ts 里数组元素的对照靠这里）。
	const readiness = async () =>
		sessionsApi.list.response.parse(await (await api.get("/projects/default/sessions")).json())
			.readiness;
	const clock = () => cp.clock as ManualClock;
	const register = async (agent: string) => {
		const res = await cp.fetch("/projects/default/workbench", {
			method: "PUT",
			headers: { "content-type": "application/json", ...bearer(bossToken) },
			body: JSON.stringify({ agent }),
		});
		expect(res.status).toBe(200);
	};

	const start = async (probes = `wb-1=${PROBE_ADDRESS}`) => {
		const probe: WorkbenchProbe = async (address, targets) => {
			calls.push({ address, targets });
			return reply(targets);
		};
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
			exposureSweepIntervalMs: 50,
			workbenchProbes: probes,
			workbenchProbe: probe,
		});
		accounts = new TestAccounts(cp.database.url);
		const bossId = await accounts.user("boss", { admin: true });
		await accounts.member("default", bossId, "project_admin");
		bossToken = await accounts.personalToken(bossId);
		api = new ApiClient(asUsers(cp));
		// 工作台自报一个随便什么地址：控制面不按它找探测服务。
		await connect("wb-1", 7001, "evil.example");
		await connect("wb-2", 7003, "10.0.0.7");
		await accounts.project("alpha");
		await connect("alpha-agent", 50052, "10.0.0.9", "alpha");
		await assistant.connected();
		await register("wb-1");
	};

	beforeEach(() => {
		calls = [];
		reply = (targets) => targets.map(() => "open");
	});
	afterEach(async () => {
		await Promise.all([...agents.keys()].map(disconnect));
		await accounts.close();
		await cp.close();
		await assistant.close();
	});

	it("探测发到部署者为这台工作台配置的地址（不是 Agent 自报的）；只探别的项目里在线的 Agent；连得通的进就绪状态，不影响 ready", async () => {
		await start();
		await eventually(async () =>
			expect((await readiness()).exposure?.agents).toEqual([
				{ agent: "alpha-agent", address: "10.0.0.9:50052" },
			]),
		);
		expect(calls).toEqual([{ address: PROBE_ADDRESS, targets: ["10.0.0.9:50052"] }]);
		const { exposure, ready } = await readiness();
		expect(ready).toBe(true);
		expect(exposure).toMatchObject({ unmeasured: 0, failed_at: null, failure: null });
	});

	it("没有给这台工作台配置探测地址：一个目标也不发，显示没测成（no_probe），不显示干净", async () => {
		await start("other-bench=sfly-workbench:47124");
		await eventually(async () =>
			expect((await readiness()).exposure).toMatchObject({
				checked_at: null,
				agents: [],
				failure: "no_probe",
			}),
		);
		expect(calls).toEqual([]);
	});

	it("没测成的目标只给个数（不列别的项目的 Agent 名和地址），不算连不通", async () => {
		reply = (targets) => targets.map(() => "error");
		await start();
		await eventually(async () =>
			expect((await readiness()).exposure).toMatchObject({
				agents: [],
				unmeasured: 1,
				failure: null,
			}),
		);
	});

	it("十分钟重探一次：一轮整个没测成时不发布新结果，留着上次的、记下时间和原因；下一轮测成了连不通，告警消失", async () => {
		await start();
		await eventually(async () => expect((await readiness()).exposure?.agents).toHaveLength(1));
		const first = (await readiness()).exposure;
		const probed = calls.length;

		reply = () => {
			throw new Error("探测服务连不上");
		};
		clock().advance(EXPOSURE_RECHECK_MS);
		await eventually(async () =>
			expect((await readiness()).exposure).toEqual({
				...first,
				failed_at: clock().now().toISOString(),
				failure: "probe_failed",
			}),
		);
		expect(calls.length).toBe(probed + 1);

		reply = (targets) => targets.map(() => "closed");
		clock().advance(EXPOSURE_RECHECK_MS);
		await eventually(async () =>
			expect((await readiness()).exposure).toEqual({
				checked_at: clock().now().toISOString(),
				agents: [],
				unmeasured: 0,
				failed_at: null,
				failure: null,
			}),
		);
	});

	describe("结果属于它测的那条连接", () => {
		/** 之后的每次探测都停在半路，按顺序一个一个放行（`release`）；`started` 是已经开始的次数。 */
		const holdProbes = () => {
			const waiting: (() => void)[] = [];
			reply = async (targets) => {
				await new Promise<void>((resolve) => waiting.push(resolve));
				return targets.map(() => "open");
			};
			return {
				started: () => calls.length,
				release: () => waiting.shift()?.(),
				releaseAll: () => {
					for (const resolve of waiting.splice(0)) resolve();
				},
			};
		};

		it("一换连接，旧连接的结果马上不算（不等下一轮测完）", async () => {
			await start();
			await eventually(async () => expect((await readiness()).exposure?.agents).toHaveLength(1));
			const held = holdProbes();
			await disconnect("wb-1");
			await connect("wb-1", 7001, "evil.example");
			await eventually(async () => expect(held.started()).toBe(2));
			expect((await readiness()).exposure).toBeNull();
			held.releaseAll();
			await eventually(async () => expect((await readiness()).exposure?.agents).toHaveLength(1));
		});

		it("探测进行中换了连接：这次结果丢掉，读到的是 null", async () => {
			const held = holdProbes();
			await start();
			await eventually(async () => expect(held.started()).toBe(1));
			await disconnect("wb-1");
			await connect("wb-1", 7001, "evil.example");
			held.release();
			// 下一次探测开始了：上一次的结果已经处理完（丢掉了）。
			await eventually(async () => expect(held.started()).toBe(2));
			expect((await readiness()).exposure).toBeNull();
			held.releaseAll();
		});

		it("探测进行中换了登记的工作台：这次结果丢掉，不挂到新登记的那台名下", async () => {
			const held = holdProbes();
			await start();
			await eventually(async () => expect(held.started()).toBe(1));
			await register("wb-2"); // 没有为 wb-2 配置探测地址
			held.release();
			await eventually(async () =>
				expect((await readiness()).exposure).toMatchObject({ failure: "no_probe" }),
			);
			expect((await readiness()).exposure?.agents).toEqual([]);
		});

		it("探测进行中工作台下线：读到的是 null", async () => {
			const held = holdProbes();
			await start();
			await eventually(async () => expect(held.started()).toBe(1));
			await disconnect("wb-1");
			await eventually(async () =>
				expect((await readiness()).problems.map((p) => p.kind)).toContain("workbench_offline"),
			);
			held.release();
			expect((await readiness()).exposure).toBeNull();
		});
	});
});

describe("探测地址的配置（SFLY_FIREWALL_PROBES）", () => {
	it("配置写错时所有工作台都按没有配置处理，原因不回显原文", async () => {
		const marker = "s3cr3tmark";
		for (const text of [
			`wb-1`,
			`wb-1=${marker}`,
			`wb-1=${marker}:0`,
			`=${marker}:1`,
			`a=b=${marker}:1`,
		]) {
			const { probes, problem } = probeConfig(`ok=host:1 ${text}`);
			expect(probes.size).toBe(0);
			expect(problem).toBe(
				"SFLY_FIREWALL_PROBES 第 2 条要写成「工作台的 Agent 名=主机:端口」，所有工作台都按没有配置探测处理",
			);
		}
		expect(probeConfig("wb-1=sfly-workbench:47124, wb-2=10.0.0.5:47124").probes).toEqual(
			new Map([
				["wb-1", "sfly-workbench:47124"],
				["wb-2", "10.0.0.5:47124"],
			]),
		);
	});
});

describe("分批探测", () => {
	const targets = Array.from(
		{ length: 2 * PROBE_BATCH + 500 },
		(_, i) => `10.1.${i >> 8}.${i & 255}:1`,
	);

	it("按协议的上限分批，结果按原来的顺序接起来", async () => {
		const batches: number[] = [];
		const results = await probeAll(
			async (_address, batch) => {
				batches.push(batch.length);
				return batch.map((t) => (t.endsWith(".7:1") ? "open" : "closed"));
			},
			PROBE_ADDRESS,
			targets,
		);
		expect(batches).toEqual([PROBE_BATCH, PROBE_BATCH, 500]);
		expect(results).toHaveLength(targets.length);
		expect(results.flatMap((r, i) => (r === "open" ? [targets[i]] : []))).toEqual(
			targets.filter((t) => t.endsWith(".7:1")),
		);
	});

	it("有一批没测成就是整轮没测成，不把一部分当成整轮的结果", async () => {
		let n = 0;
		await expect(
			probeAll(
				async (_address, batch) => {
					n += 1;
					if (n === 2) throw new Error("第二批没测成");
					return batch.map(() => "closed");
				},
				PROBE_ADDRESS,
				targets,
			),
		).rejects.toThrow("第二批没测成");
	});
});
