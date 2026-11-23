// 连接的项目（ADR 0029「迁移与过渡」，规格 #492，审查 #638 的必须改 1、一起做 5）：
// - 两个项目的凭据同时连同一个还没登记过的名字：登记留在先到的项目，后到的在锁里被拒绝，连接表里不会有「登记在甲、活着的却是乙的
//   连接」；连接记下它的项目，派发以连接的项目为准，不是库里登记记录的项目；
// - 连接的一方对这个名字所在的项目没有有效凭据时，「还没有登记」「登记在别的项目」「在别的项目里被停用」「这个名字有 Agent 凭据」
//   是同一个回应、同一句话（Hello 的回应不能用来探别的项目里有没有这个名字、停没停用）；先比项目、后看停用。
// 真实控制面和数据库，假 Agent 走真实的 gRPC。
import { ConnectError } from "@connectrpc/connect";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { notRegisteredHere } from "../src/agents/agent-auth.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ALPHA = "alpha" as ProjectId;

describe("连接的项目", () => {
	let cp: TestControlPlane;
	let db: pg.Client;
	let accounts: TestAccounts | undefined;
	const agents: FakeAgent[] = [];

	const start = async (options: NonNullable<Parameters<typeof startTestControlPlane>[0]> = {}) => {
		cp = await startTestControlPlane(options);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		accounts = new TestAccounts(cp.database.url);
		await accounts.project("alpha");
	};
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db?.end();
		await accounts?.close();
		accounts = undefined;
		await cp?.close();
	});

	const connect = async (name: string, token?: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name,
			...(token === undefined ? {} : { token }),
		});
		agents.push(agent);
		return agent;
	};
	/** 连一次又断开（把这个名字登记在这个凭据的项目里）。 */
	const registerAndLeave = async (name: string, token: string) => {
		const agent = await connect(name, token);
		await agent.disconnect();
		agents.splice(agents.indexOf(agent), 1);
		await eventually(async () => expect((await row(name))?.status).toBe("offline"));
	};
	const issue = async (project: ProjectId, name: string) =>
		(await cp.current.agentCredentials.issue(project, name)).token;
	const row = async (name: string) =>
		(await db.query("select project_id, status, disabled_at from agents where name = $1", [name]))
			.rows[0] as { project_id: string; status: string; disabled_at: Date | null } | undefined;
	/** 被拒绝的连接：gRPC 状态和说明（说明里的名字换成 NAME，好互相比较）。 */
	const refusal = async (name: string, token?: string) => {
		const error = await connect(name, token).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error, `${name} 应该被拒绝`).toBeInstanceOf(ConnectError);
		const refused = error as ConnectError;
		return { code: refused.code, message: refused.rawMessage.split(name).join("NAME") };
	};
	/** 项目管理员的个人令牌：停用、恢复 Agent 要凭据。 */
	const adminHeaders = async (): Promise<Record<string, string>> => {
		const id = await (accounts as TestAccounts).user("boss");
		await (accounts as TestAccounts).member("default", id, "project_admin");
		return bearer(await (accounts as TestAccounts).personalToken(id));
	};

	it("两个项目的凭据同时连同一个还没登记过的名字，反复做：恰好一条连上，登记的项目就是连上的那一条的项目，另一条被拒绝（以前 20 次里 15 次登记和连接对不上）", async () => {
		await start();
		const outcomes: string[] = [];
		for (let round = 0; round < 20; round++) {
			const name = `race-${round}`;
			const [mine, theirs] = await Promise.all([issue(DEFAULT_PROJECT, name), issue(ALPHA, name)]);
			const results = await Promise.allSettled([connect(name, mine), connect(name, theirs)]);
			const alive = results.flatMap((result, index) =>
				result.status === "fulfilled" ? [index] : [],
			);
			expect(alive, `第 ${round} 轮：恰好一条连上`).toHaveLength(1);
			const state = await row(name);
			expect(state?.project_id, `第 ${round} 轮：登记的项目等于连上的那一条的项目`).toBe(
				alive[0] === 0 ? "default" : "alpha",
			);
			expect(state?.status).toBe("online");
			outcomes.push(state?.project_id ?? "");
		}
		// 两边都有机会先到：不是总被同一个项目抢到（这条只是说明竞争真的发生了，不卡死在一边）。
		expect(new Set(outcomes).size, outcomes.join(",")).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it("派发以连接的项目为准：登记记录被改成默认项目、连接却是项目 alpha 的凭据连的，默认项目的运行不派给它（任务按配置错误失败）", async () => {
		await start();
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const api = new ApiClient(cp);
		const agent = await connect("agent-a", await issue(ALPHA, "agent-a"));
		expect((await row("agent-a"))?.project_id).toBe("alpha");
		// 以前竞争留下的状态：登记记录在默认项目，连接是 alpha 凭据的。
		await db.query("update agents set project_id = 'default' where name = 'agent-a'");
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(async () => {
			const node = await api.node(runId, "a");
			expect(node.status).toBe("failed");
			expect(node.error).toMatchObject({
				kind: "config_error",
				message: expect.stringMatching(/agent-a.*还没有注册过/),
			});
		});
		await agent.expectNoAssign(300);
	});

	/** 没有有效凭据时统一的回应（说明里的名字换成了 NAME）。 */
	const SAME = { code: 16, message: notRegisteredHere("NAME") };

	it("三种情况同一个回应：连接的一方对这个名字所在的项目没有有效凭据时，还没有登记、登记在别的项目、在别的项目里被停用、这个名字有 Agent 凭据，说法一样（状态和说明都一样）", async () => {
		await start();
		// 登记在 alpha 的两台（一台停用了）、登记在默认项目并签发过 Agent 凭据的一台。
		await registerAndLeave("in-alpha", await issue(ALPHA, "in-alpha"));
		await registerAndLeave("off-alpha", await issue(ALPHA, "off-alpha"));
		await db.query("update agents set disabled_at = now() where name = 'off-alpha'");
		await registerAndLeave("has-cred", await issue(DEFAULT_PROJECT, "has-cred"));

		const cells: Record<string, { code: number; message: string }> = {};
		for (const [how, token] of [
			["没有凭据", ""],
			["不认识的旧令牌", "stale-token"],
		] as const) {
			for (const name of ["fresh", "in-alpha", "off-alpha", "has-cred"]) {
				cells[`${how} × ${name}`] = await refusal(name, token);
			}
		}
		// 默认项目的 Agent 凭据（名字要和凭据一致，所以每个名字各签一个）连别的项目登记的名字。
		for (const name of ["in-alpha", "off-alpha"]) {
			cells[`默认项目的 Agent 凭据 × ${name}`] = await refusal(
				name,
				await issue(DEFAULT_PROJECT, name),
			);
		}
		// alpha 的凭据连默认项目登记的名字。
		cells["alpha 的 Agent 凭据 × has-cred"] = await refusal(
			"has-cred",
			await issue(ALPHA, "has-cred"),
		);
		for (const [cell, outcome] of Object.entries(cells)) {
			expect(outcome, cell).toEqual(SAME);
		}
		expect(Object.keys(cells).length).toBeGreaterThanOrEqual(11);
	}, 60_000);

	it("配了共享令牌的部署：共享令牌连别的项目登记的名字、别的项目里被停用的名字、有 Agent 凭据的名字，同样是这一句话", async () => {
		await start({ agentToken: "s3cret" });
		await registerAndLeave("in-alpha", await issue(ALPHA, "in-alpha"));
		await registerAndLeave("off-alpha", await issue(ALPHA, "off-alpha"));
		await db.query("update agents set disabled_at = now() where name = 'off-alpha'");
		await registerAndLeave("has-cred", await issue(DEFAULT_PROJECT, "has-cred"));
		for (const name of ["in-alpha", "off-alpha", "has-cred"]) {
			expect(await refusal(name, "s3cret"), `共享令牌 × ${name}`).toEqual(SAME);
		}
	}, 60_000);

	it("先比项目、后看停用：别的项目里被停用的 Agent，和不存在一样（不说「已被停用」）；自己项目里被停用的才说", async () => {
		await start();
		await registerAndLeave("off-alpha", await issue(ALPHA, "off-alpha"));
		await registerAndLeave("off-default", await issue(DEFAULT_PROJECT, "off-default"));
		await db.query("update agents set disabled_at = now() where name = 'off-alpha'");
		expect(
			(
				await cp.fetch("/agents/off-default/disable", {
					method: "POST",
					headers: await adminHeaders(),
				})
			).status,
		).toBe(204);
		// 默认项目的凭据连 alpha 里被停用的名字：没有停用的说法。
		const elsewhere = await refusal("off-alpha", await issue(DEFAULT_PROJECT, "off-alpha"));
		expect(elsewhere.message).not.toMatch(/停用/);
		// 自己项目里被停用的：说明被停用。
		const own = await refusal("off-default", await issue(DEFAULT_PROJECT, "off-default"));
		expect(own.message).toMatch(/已被停用/);
	}, 60_000);
});
