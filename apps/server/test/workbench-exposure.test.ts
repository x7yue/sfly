// 工作台够得着的项目外 Agent（#498）：控制面定期请工作台前面的出网名单容器只试连接别的项目里在线 Agent 的能力端口，结果带进
// 就绪状态（助手页、会话页告警）。真实控制面和数据库，进程内的假助手服务，假 Agent 当工作台和别的项目的 Agent，探测换成假的
// （真的探测服务在 deploy/workbench/firewall.py，scripts/tests 和 compose 冒烟里测）。
import { sessionsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("工作台探测项目外 Agent 的能力端口", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	/** 每次探测（主机、目标）；回什么由 `reply` 决定，抛错就是这一轮没测成。 */
	let calls: { host: string; targets: string[] }[];
	let reply: (targets: string[]) => ProbeResult[];

	const connect = async (name: string, port: number, address: string, token?: string) => {
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name, peer: { port, publicAddress: address }, ...(token && { token }) },
			{ clock: cp.clock },
		);
		agents.push(agent);
		return agent;
	};
	// 按契约的 schema 解析（read-only-routes.test.ts 里数组元素的对照靠这里）。
	const readiness = async () =>
		sessionsApi.list.response.parse(await (await api.get("/projects/default/sessions")).json())
			.readiness;
	const advance = () => (cp.clock as ManualClock).advance(EXPOSURE_RECHECK_MS);
	const workbenchToken = async () =>
		(await cp.current.agentCredentials.issue("default" as never, "wb-1")).token;

	beforeEach(async () => {
		calls = [];
		reply = (targets) => targets.map(() => "open");
		const probe: WorkbenchProbe = async (host, targets) => {
			calls.push({ host, targets });
			return reply(targets);
		};
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
			exposureSweepIntervalMs: 50,
			workbenchProbe: probe,
		});
		accounts = new TestAccounts(cp.database.url);
		const bossId = await accounts.user("boss", { admin: true });
		await accounts.member("default", bossId, "project_admin");
		api = new ApiClient(asUsers(cp));
		await connect("wb-1", 7001, "10.0.0.5", await workbenchToken());
		await connect("peer-1", 7002, "10.0.0.6");
		await accounts.project("alpha");
		const alpha = await cp.current.agentCredentials.issue("alpha" as never, "alpha-agent");
		await connect("alpha-agent", 50052, "10.0.0.9", alpha.token);
		await assistant.connected();
		const res = await cp.fetch("/projects/default/workbench", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...bearer(await accounts.personalToken(bossId)),
			},
			body: JSON.stringify({ agent: "wb-1" }),
		});
		expect(res.status).toBe(200);
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await accounts.close();
		await cp.close();
		await assistant.close();
	});

	it("请工作台的主机探别的项目里在线 Agent 的能力端口；连得通的进就绪状态，不影响 ready", async () => {
		await eventually(async () =>
			expect((await readiness()).exposure?.agents).toEqual([
				{ agent: "alpha-agent", address: "10.0.0.9:50052" },
			]),
		);
		expect(calls[0]).toEqual({ host: "10.0.0.5", targets: ["10.0.0.9:50052"] });
		const { exposure, ready } = await readiness();
		expect(ready).toBe(true);
		expect(exposure).toMatchObject({ unmeasured: [], failed_at: null });
		expect(exposure?.checked_at).toBe((cp.clock as ManualClock).now().toISOString());
	});

	it("没测成的目标单独列出，不算连不通", async () => {
		reply = (targets) => targets.map(() => "error");
		await eventually(async () =>
			expect((await readiness()).exposure).toMatchObject({
				agents: [],
				unmeasured: [{ agent: "alpha-agent", address: "10.0.0.9:50052" }],
				failed_at: null,
			}),
		);
	});

	it("十分钟重探一次：连不通了告警消失；一轮整个没测成时不发布新结果，留着上次的、记下没测成的时间", async () => {
		await eventually(async () => expect((await readiness()).exposure?.agents).toHaveLength(1));
		const first = (await readiness()).exposure;
		const probed = calls.length;

		reply = () => {
			throw new Error("探测服务连不上");
		};
		advance();
		await eventually(async () => expect(calls.length).toBe(probed + 1));
		await eventually(async () =>
			expect((await readiness()).exposure).toEqual({
				...first,
				failed_at: (cp.clock as ManualClock).now().toISOString(),
			}),
		);

		reply = (targets) => targets.map(() => "closed");
		advance();
		await eventually(async () =>
			expect((await readiness()).exposure).toMatchObject({
				agents: [],
				unmeasured: [],
				failed_at: null,
				checked_at: (cp.clock as ManualClock).now().toISOString(),
			}),
		);
	});

	it("工作台换了连接：旧连接的结果作废，新连接没测成时就是没有结果", async () => {
		await eventually(async () => expect((await readiness()).exposure?.agents).toHaveLength(1));
		reply = () => {
			throw new Error("探测服务连不上");
		};
		const wb = agents[0] as FakeAgent;
		await wb.disconnect();
		await connect("wb-1", 7001, "10.0.0.5", await workbenchToken());
		await eventually(async () =>
			expect((await readiness()).exposure).toEqual({
				checked_at: null,
				agents: [],
				unmeasured: [],
				failed_at: expect.any(String),
			}),
		);
	});

	it("工作台不在线时没有结果（null）", async () => {
		const wb = agents[0] as FakeAgent;
		await wb.disconnect();
		await eventually(async () => expect((await readiness()).exposure).toBeNull());
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
			async (_host, batch) => {
				batches.push(batch.length);
				return batch.map((t) => (t.endsWith(".7:1") ? "open" : "closed"));
			},
			"10.0.0.5",
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
				async (_host, batch) => {
					n += 1;
					if (n === 2) throw new Error("第二批没测成");
					return batch.map(() => "closed");
				},
				"10.0.0.5",
				targets,
			),
		).rejects.toThrow("第二批没测成");
	});
});
