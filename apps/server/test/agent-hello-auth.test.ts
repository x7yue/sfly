// Agent 连接时的身份（ADR 0029「迁移与过渡」、ADR 0014，规格 #492）：Hello.token 是 Agent 凭据时项目和名字从凭据得出，
// 名字不一致就拒绝；共享令牌和「没有凭据的已登记 Agent」两种兼容方式；以旧方式连接的不能顶掉带 Agent 凭据的同名连接；
// 凭据吊销、Agent 停用时断开连接。真实控制面和数据库，假 Agent 走真实的 gRPC。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("Agent 连接时的身份", () => {
	let cp: TestControlPlane;
	let db: pg.Client;
	const agents: FakeAgent[] = [];

	let accounts: TestAccounts | undefined;
	const start = async (options: NonNullable<Parameters<typeof startTestControlPlane>[0]> = {}) => {
		cp = await startTestControlPlane(options);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
	};
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db?.end();
		await accounts?.close();
		accounts = undefined;
		adminHeaders = undefined;
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
	/** 项目管理员的个人令牌：停用、恢复 Agent 要凭据（现在就要，不等 #494）。 */
	let adminHeaders: Record<string, string> | undefined;
	const admin = async (): Promise<Record<string, string>> => {
		if (adminHeaders) return adminHeaders;
		accounts ??= new TestAccounts(cp.database.url);
		const id = await accounts.user("boss");
		await accounts.member("default", id, "project_admin");
		adminHeaders = bearer(await accounts.personalToken(id));
		return adminHeaders;
	};
	const toggle = async (name: string, action: "disable" | "enable") =>
		(await cp.fetch(`/agents/${name}/${action}`, { method: "POST", headers: await admin() }))
			.status;
	/** 把一个名字登记到项目 alpha（凭据连一次再断开），返回 alpha 里这台的凭据。 */
	const alphaAgent = async (name: string) => {
		await db.query(
			"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now()) on conflict do nothing",
		);
		return cp.current.agentCredentials.issue("alpha" as never, name);
	};
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
			const alien = (await alphaAgent("worker-1")).token;
			// 不透露「在别的项目里」：和没有登记过是同一句话（见下面「三种情况同一个回应」）。
			await expect(connect("worker-1", alien)).rejects.toThrow(/不能连接/);
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
			// 先用凭据登记一台，管理员把它的凭据全部吊销之后（那是明确的选择），没有凭据才又接受它的名字。
			const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "known");
			const first = await connect("known", issued.token);
			await first.disconnect();
			agents.splice(agents.indexOf(first), 1);
			await eventually(async () => expect((await row("known")).status).toBe("offline"));
			await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "known", issued.credential.id);
			await connect("known", "");
			expect((await row("known")).last_auth_kind).toBe("none");
			await expect(connect("stranger", "")).rejects.toThrow(/不能连接/);
			expect(await registered()).toEqual(["known"]);
		});

		it("没有配共享令牌：带一个不认识的旧令牌，和没有凭据一样（旧版本照旧接受已登记的名字）", async () => {
			await start();
			const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "known");
			const first = await connect("known", issued.token);
			await first.disconnect();
			agents.splice(agents.indexOf(first), 1);
			await eventually(async () => expect((await row("known")).status).toBe("offline"));
			await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "known", issued.credential.id);
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
			await expect(connect("worker-1", "s3cret")).rejects.toThrow(/不能连接/);
			expect(secured.ended).toBe(false);
			const state = await row("worker-1");
			expect(state).toMatchObject({ status: "online", last_auth_kind: "agent" });
		});

		it("没有配共享令牌时，没有凭据的新连接同样顶不掉带 Agent 凭据的连接", async () => {
			await start();
			const secured = await connect("worker-1", await issue("worker-1"));
			await expect(connect("worker-1", "")).rejects.toThrow(/不能连接/);
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
			expect(await toggle("worker-1", "disable")).toBe(204);
			await expect(connect("worker-1", token)).rejects.toThrow(/停用/);
			// 这个名字有 Agent 凭据：旧方式（共享令牌、没有凭据）直接是「不能连接」，不说停用没停用。
			await expect(connect("worker-1", "s3cret")).rejects.toThrow(/不能连接/);
			expect((await row("worker-1")).status).toBe("offline");
			expect(await toggle("worker-1", "enable")).toBe(204);
			await connect("worker-1", token);
			expect((await row("worker-1")).status).toBe("online");
		});

		it("停用一台正连着的 Agent：立即断开连接", async () => {
			await start();
			const agent = await connect("worker-1", await issue("worker-1"));
			expect(await toggle("worker-1", "disable")).toBe(204);
			await eventually(async () => expect(agent.ended).toBe(true));
			await eventually(async () => expect((await row("worker-1")).status).toBe("offline"));
			expect((await row("worker-1")).disabled_at).not.toBeNull();
		});
	});

	describe("开发 Agent 的凭据：所属用户被停用", () => {
		const ADMIN = { loginName: "root", password: "admin-password-1" };

		it("停用用户：他的开发 Agent 立即断开、连不上（凭据没有吊销）；别的用户的、按台签发的不受影响；启用之后同一个凭据照常", async () => {
			await start({ initialAdmin: ADMIN });
			accounts = new TestAccounts(cp.database.url);
			const alice = await accounts.user("alice");
			const bob = await accounts.user("bob");
			const aliceCred = await cp.current.agentCredentials.issue(
				DEFAULT_PROJECT,
				"dev-alice-laptop",
				{
					userId: alice,
				},
			);
			const bobCred = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-bob-laptop", {
				userId: bob,
			});
			const login = await cp.fetch("/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
			});
			const cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
			const post = (path: string) =>
				cp.fetch(path, { method: "POST", headers: loginCookie(cookie) });

			const mine = await connect("dev-alice-laptop", aliceCred.token);
			const his = await connect("dev-bob-laptop", bobCred.token);
			const machine = await connect("worker-1", await issue("worker-1"));

			expect((await post(`/users/${alice}/disable`)).status).toBe(200);
			await eventually(async () => expect(mine.ended).toBe(true));
			await eventually(async () => expect((await row("dev-alice-laptop")).status).toBe("offline"));
			expect(his.ended).toBe(false);
			expect(machine.ended).toBe(false);
			// 停用期间连不上；凭据没有被吊销。
			await expect(connect("dev-alice-laptop", aliceCred.token)).rejects.toThrow(
				/所属的用户已被停用/,
			);
			expect(
				(
					await db.query("select revoked_at from agent_credentials where id = $1", [
						aliceCred.credential.id,
					])
				).rows[0].revoked_at,
			).toBeNull();
			expect((await row("dev-alice-laptop")).status).toBe("offline");

			expect((await post(`/users/${alice}/enable`)).status).toBe(200);
			await connect("dev-alice-laptop", aliceCred.token);
			expect((await row("dev-alice-laptop")).status).toBe("online");
		});

		it("所属用户在库里被停用（没有经过停用接口）：新的连接同样被拒绝", async () => {
			await start();
			accounts = new TestAccounts(cp.database.url);
			const carol = await accounts.user("carol");
			const cred = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-carol-box", {
				userId: carol,
			});
			await db.query("update users set disabled_at = now() where id = $1", [carol]);
			await expect(connect("dev-carol-box", cred.token)).rejects.toThrow(/所属的用户已被停用/);
			expect(await registered()).toEqual([]);
		});
	});
});
