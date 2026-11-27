// 连接的项目（ADR 0029「迁移与过渡」，规格 #492，审查 #638 的必须改 1、一起做 5）：
// - 两个项目的凭据同时连同一个还没登记过的名字：登记留在先到的项目，后到的在锁里被拒绝，连接表里不会有「登记在甲、活着的却是乙的
//   连接」；连接记下它的项目，派发以连接的项目为准，不是库里登记记录的项目；
// - 连接的一方对这个名字所在的项目没有有效凭据时，「还没有登记」「登记在别的项目」「在别的项目里被停用」「这个名字有 Agent 凭据」
//   是同一个回应、同一句话（Hello 的回应不能用来探别的项目里有没有这个名字、停没停用）；先比项目、后看停用。
//   例外（#492 的 E）：带着这个名字的有效 Agent 凭据的调用方看到具体原因（名字已经被另一个项目登记）。
// 真实控制面和数据库，假 Agent 走真实的 gRPC。
import { ConnectError } from "@connectrpc/connect";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { nameRegisteredElsewhere, notRegisteredHere } from "../src/agents/agent-auth.js";
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
	const alphaCredential = (name: string) => issue(ALPHA, name);
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
		for (const [cell, outcome] of Object.entries(cells)) {
			expect(outcome, cell).toEqual(SAME);
		}
		expect(Object.keys(cells).length).toBeGreaterThanOrEqual(8);
	}, 60_000);

	// #492 的 E：带着这个名字的、有效的 Agent 凭据的调用方（它已经证明自己是管理员为这个项目、这个名字签发的那一台）看得到具体原因。
	// 对它，「名字登记在别的项目里」是唯一可能的拒绝原因（有效的凭据能登记一个新名字，所以「还没有登记」不会是原因），
	// 它本来就看得到「连上了」还是「被拒绝了」，说出原因没有多告诉它什么。
	describe("带着有效 Agent 凭据的调用方：名字登记在别的项目里时看到具体原因", () => {
		const SPECIFIC = { code: 7, message: nameRegisteredElsewhere("NAME") };

		it("默认项目的凭据连 alpha 里登记的名字、alpha 的凭据连默认项目里登记的名字（不论占着名字的 Agent 在不在线、停没停用、怎么连接的）：同一句具体的说明，不透露是哪个项目、怎么连接的、停没停用", async () => {
			await start({ agentToken: "s3cret" });
			await registerAndLeave("in-alpha", await issue(ALPHA, "in-alpha"));
			await registerAndLeave("off-alpha", await issue(ALPHA, "off-alpha"));
			await db.query("update agents set disabled_at = now() where name = 'off-alpha'");
			// 占着默认项目里的名字的是一台共享令牌连接的 Agent（过渡期里最常见）、一台带凭据的。
			await connect("by-shared", "s3cret").then((agent) => agent.disconnect());
			await registerAndLeave("has-cred", await issue(DEFAULT_PROJECT, "has-cred"));
			const cells: Record<string, { code: number; message: string }> = {};
			for (const name of ["in-alpha", "off-alpha"]) {
				cells[`默认项目的凭据 × ${name}`] = await refusal(name, await issue(DEFAULT_PROJECT, name));
			}
			for (const name of ["by-shared", "has-cred"]) {
				cells[`alpha 的凭据 × ${name}`] = await refusal(name, await issue(ALPHA, name));
			}
			for (const [cell, outcome] of Object.entries(cells)) {
				expect(outcome, cell).toEqual(SPECIFIC);
			}
			expect(Object.keys(cells)).toHaveLength(4);
			// 说明里写明怎么办，不带项目、不带占着名字的 Agent 怎么连接的。
			expect(SPECIFIC.message).toMatch(/换一个名字/);
			expect(SPECIFIC.message).not.toMatch(/alpha|默认|default|共享令牌|停用/);
			// 被拒绝的没有登记，也没有改动那边的登记。
			expect((await row("by-shared"))?.project_id).toBe("default");
			expect((await row("in-alpha"))?.project_id).toBe("alpha");
		}, 60_000);

		it("别的调用方照旧笼统：没有凭据、共享令牌、不认识的令牌和凭据、凭据的名字和 Hello 的名字对不上，都看不到这条具体原因，也看不出名字有没有登记", async () => {
			await start({ agentToken: "s3cret" });
			// 名字 taken 登记在 alpha（先用共享令牌连一次登记，再把登记改到 alpha）。
			await connect("taken", "s3cret").then((agent) => agent.disconnect());
			await db.query("update agents set project_id = 'alpha' where name = 'taken'");
			// 没有凭据、共享令牌：对这个名字所在的项目没有有效凭据，笼统的一句（和还没有登记是同一句）。
			expect(await refusal("taken", "")).toMatchObject({ code: 16 });
			expect(await refusal("taken", "s3cret")).toEqual(SAME);
			expect((await refusal("taken", "")).message).toContain("共享令牌");
			// 不认识的令牌和 Agent 凭据：令牌无效，不碰名字。
			for (const token of ["stale-token", `sfly_agt_${"0".repeat(48)}`]) {
				const refused = await refusal("taken", token);
				expect(refused, token).toEqual({ code: 16, message: "invalid agent token" });
			}
			// alpha 的凭据（名字是 other-name）拿去连 taken：名字对不上，说明只提凭据自己的名字，不提 taken 有没有登记。
			const mismatch = await refusal("taken", await issue(ALPHA, "other-name"));
			expect(mismatch.code).toBe(7);
			expect(mismatch.message).toContain("other-name");
			expect(mismatch.message).not.toMatch(/另一个项目|已经登记/);
			// 这些都没有改 taken 的登记。
			expect((await row("taken"))?.project_id).toBe("alpha");
		}, 60_000);

		it("吊销的凭据说已吊销，还是不说别的项目的事（名字登记在别的项目也一样）", async () => {
			await start();
			await registerAndLeave("in-alpha", await issue(ALPHA, "in-alpha"));
			const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "in-alpha");
			await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "in-alpha", issued.credential.id);
			const revoked = await refusal("in-alpha", issued.token);
			expect(revoked.code).toBe(16);
			expect(revoked.message).toContain("吊销");
			expect(revoked.message).not.toMatch(/另一个项目/);
		}, 60_000);

		it("两个项目的凭据同时连同一个还没登记的名字：连上的那条登记，另一条（它也带着有效凭据）看到具体原因", async () => {
			await start();
			for (let round = 0; round < 6; round++) {
				const name = `race-e-${round}`;
				const [mine, theirs] = await Promise.all([
					issue(DEFAULT_PROJECT, name),
					issue(ALPHA, name),
				]);
				const results = await Promise.allSettled([connect(name, mine), connect(name, theirs)]);
				const refused = results.flatMap((result) =>
					result.status === "rejected" ? [result.reason as ConnectError] : [],
				);
				expect(refused, `第 ${round} 轮：恰好一条被拒绝`).toHaveLength(1);
				expect(refused[0]?.code).toBe(7);
				expect(refused[0]?.rawMessage.split(name).join("NAME")).toBe(SPECIFIC.message);
			}
		}, 60_000);
	});

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

	it("只看这个项目里的 Agent 凭据：别的项目为同一个名字签发了凭据，不能让默认项目里用旧方式连着的那台连不上", async () => {
		await start({ agentToken: "s3cret" });
		await connect("legacy-1", "s3cret");
		await alphaCredential("legacy-1");
		// 默认项目里这个名字没有 Agent 凭据：共享令牌照旧能重连（顶掉旧连接）。
		await connect("legacy-1", "s3cret");
		expect((await row("legacy-1"))?.project_id).toBe("default");
		// 默认项目为它签发了凭据之后才只认凭据。
		await issue(DEFAULT_PROJECT, "legacy-1");
		expect((await refusal("legacy-1", "s3cret")).message).toBe(SAME.message);
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
