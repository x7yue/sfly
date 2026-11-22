// Agent 连接时的身份（ADR 0029「迁移与过渡」、ADR 0014，规格 #492）：Hello.token 是 Agent 凭据时项目和名字从凭据得出，
// 名字不一致就拒绝；共享令牌和「没有凭据的已登记 Agent」两种兼容方式；以旧方式连接的不能顶掉带 Agent 凭据的同名连接；
// 凭据吊销、Agent 停用时断开连接。真实控制面和数据库，假 Agent 走真实的 gRPC。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("Agent 连接时的身份", () => {
	let cp: TestControlPlane;
	let db: pg.Client;
	const agents: FakeAgent[] = [];

	const start = async (options: { agentToken?: string } = {}) => {
		cp = await startTestControlPlane(options);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
	};
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db?.end();
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
	const issue = async (name: string) =>
		(await cp.current.agentCredentials.issue(DEFAULT_PROJECT, name)).token;
	const row = async (name: string) =>
		(
			await db.query(
				"select project_id, status, last_auth_kind, disabled_at from agents where name = $1",
				[name],
			)
		).rows[0];
	const registered = async () =>
		(await db.query("select name from agents order by name")).rows.map((r) => r.name as string);
	const lastUsed = async (token: string) =>
		(
			await db.query("select last_used_at from agent_credentials where prefix = $1", [
				token.slice(0, 13),
			])
		).rows[0]?.last_used_at as Date | null | undefined;

	describe("Agent 凭据", () => {
		it("用自己的凭据连上：项目和名字从凭据得出，记下用的是 Agent 凭据和凭据的最后使用时间", async () => {
			await start();
			const token = await issue("worker-1");
			await connect("worker-1", token);
			expect(await row("worker-1")).toMatchObject({
				project_id: "default",
				status: "online",
				last_auth_kind: "agent",
			});
			expect(await lastUsed(token)).not.toBeNull();
		});

		it("用一台 Agent 的凭据、报另一台的名字：拒绝，不登记那个名字", async () => {
			await start();
			const token = await issue("worker-1");
			await expect(connect("worker-2", token)).rejects.toThrow(/worker-1/);
			expect(await registered()).toEqual([]);
		});

		it("别的项目的凭据不能用来连默认项目里已经登记的名字（名字全局唯一）", async () => {
			await start();
			await connect("worker-1", await issue("worker-1"));
			await db.query(
				"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now())",
			);
			const alien = (await cp.current.agentCredentials.issue("alpha" as never, "worker-1")).token;
			await expect(connect("worker-1", alien)).rejects.toThrow(/别的项目/);
			expect((await row("worker-1")).project_id).toBe("default");
		});

		it("吊销的、不认识的 sfly_agt_ 凭据被拒绝，不登记", async () => {
			await start();
			const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "worker-1");
			await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id);
			await expect(connect("worker-1", issued.token)).rejects.toThrow(/吊销|token/i);
			await expect(connect("worker-1", `sfly_agt_${"0".repeat(48)}`)).rejects.toThrow(/token/i);
			expect(await registered()).toEqual([]);
		});

		it("吊销凭据：用它连着的连接立即断开；别的凭据的连接不受影响", async () => {
			await start();
			const first = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "worker-1");
			const other = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "worker-2");
			const a = await connect("worker-1", first.token);
			const b = await connect("worker-2", other.token);
			await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "worker-1", first.credential.id);
			await eventually(async () => expect(a.ended).toBe(true));
			await eventually(async () => expect((await row("worker-1")).status).toBe("offline"));
			expect(b.ended).toBe(false);
			expect((await row("worker-2")).status).toBe("online");
		});
	});

	describe("过渡：共享令牌和没有凭据", () => {
		it("配了共享令牌：不带令牌、令牌不对都被拒绝；带对的令牌连上，记下用的是共享令牌；Agent 凭据照常", async () => {
			await start({ agentToken: "s3cret" });
			await expect(connect("anon", "")).rejects.toThrow(/token/i);
			await expect(connect("intruder", "wrong")).rejects.toThrow(/token/i);
			expect(await registered()).toEqual([]);
			await connect("legacy", "s3cret");
			expect((await row("legacy")).last_auth_kind).toBe("shared");
			await connect("modern", await issue("modern"));
			expect((await row("modern")).last_auth_kind).toBe("agent");
		});

		it("没有配共享令牌：没有凭据的 Agent 只接受已登记的名字；没登记过的被拒绝，提示去签发凭据", async () => {
			await start();
			// 先用凭据登记一台，之后它「忘了」凭据，没有凭据重连。
			const first = await connect("known", await issue("known"));
			await first.disconnect();
			agents.splice(agents.indexOf(first), 1);
			await eventually(async () => expect((await row("known")).status).toBe("offline"));
			await connect("known", "");
			expect((await row("known")).last_auth_kind).toBe("none");
			await expect(connect("stranger", "")).rejects.toThrow(/已登记|凭据/);
			expect(await registered()).toEqual(["known"]);
		});

		it("没有配共享令牌：带一个不认识的旧令牌，和没有凭据一样（旧版本照旧接受已登记的名字）", async () => {
			await start();
			const first = await connect("known", await issue("known"));
			await first.disconnect();
			agents.splice(agents.indexOf(first), 1);
			await eventually(async () => expect((await row("known")).status).toBe("offline"));
			await connect("known", "stale-token-from-before");
			expect((await row("known")).last_auth_kind).toBe("none");
		});
	});

	describe("同名连接的顶掉规则（Agent 重启、断电后重连）", () => {
		it("以旧方式连接的新连接能顶掉同名的以旧方式连接（旧连接已死）", async () => {
			await start({ agentToken: "s3cret" });
			const old = await connect("legacy", "s3cret");
			const fresh = await connect("legacy", "s3cret");
			await eventually(async () => expect(old.ended).toBe(true));
			expect(fresh.ended).toBe(false);
			expect((await row("legacy")).status).toBe("online");
		});

		it("以旧方式连接的新连接顶不掉同名的带 Agent 凭据的连接：被拒绝，原连接不受影响", async () => {
			await start({ agentToken: "s3cret" });
			const secured = await connect("worker-1", await issue("worker-1"));
			await expect(connect("worker-1", "s3cret")).rejects.toThrow(/不能顶掉/);
			expect(secured.ended).toBe(false);
			const state = await row("worker-1");
			expect(state).toMatchObject({ status: "online", last_auth_kind: "agent" });
		});

		it("没有配共享令牌时，没有凭据的新连接同样顶不掉带 Agent 凭据的连接", async () => {
			await start();
			const secured = await connect("worker-1", await issue("worker-1"));
			await expect(connect("worker-1", "")).rejects.toThrow(/不能顶掉/);
			expect(secured.ended).toBe(false);
		});

		it("带 Agent 凭据的新连接能顶掉同名的任何连接", async () => {
			await start({ agentToken: "s3cret" });
			const legacy = await connect("worker-1", "s3cret");
			const first = await connect("worker-1", await issue("worker-1"));
			await eventually(async () => expect(legacy.ended).toBe(true));
			const second = await connect("worker-1", await issue("worker-1"));
			await eventually(async () => expect(first.ended).toBe(true));
			expect(second.ended).toBe(false);
			expect((await row("worker-1")).last_auth_kind).toBe("agent");
		});
	});

	describe("停用和恢复", () => {
		it("停用的 Agent 连不上，不论带 Agent 凭据、共享令牌还是没有凭据；恢复之后照常", async () => {
			await start({ agentToken: "s3cret" });
			const token = await issue("worker-1");
			const first = await connect("worker-1", token);
			await first.disconnect();
			agents.splice(agents.indexOf(first), 1);
			await eventually(async () => expect((await row("worker-1")).status).toBe("offline"));
			expect((await cp.fetch("/agents/worker-1/disable", { method: "POST" })).status).toBe(204);
			await expect(connect("worker-1", token)).rejects.toThrow(/停用/);
			await expect(connect("worker-1", "s3cret")).rejects.toThrow(/停用/);
			expect((await row("worker-1")).status).toBe("offline");
			expect((await cp.fetch("/agents/worker-1/enable", { method: "POST" })).status).toBe(204);
			await connect("worker-1", token);
			expect((await row("worker-1")).status).toBe("online");
		});

		it("停用一台正连着的 Agent：立即断开连接", async () => {
			await start();
			const agent = await connect("worker-1", await issue("worker-1"));
			expect((await cp.fetch("/agents/worker-1/disable", { method: "POST" })).status).toBe(204);
			await eventually(async () => expect(agent.ended).toBe(true));
			await eventually(async () => expect((await row("worker-1")).status).toBe("offline"));
			expect((await row("worker-1")).disabled_at).not.toBeNull();
		});
	});
});
