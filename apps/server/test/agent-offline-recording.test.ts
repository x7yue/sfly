// 吊销、停用时把 Agent 记为离线（#878）。Hub 的连接表只在对应的写库成功之后才改：写离线失败时，已关闭的连接留在表里，
// 下一次碰到这个名字的操作重试。按不变式测：某个操作这次写库失败，之后任意一个碰到这个名字的操作成功，
// 库里的 status 就等于「有没有活着的当前连接」。另有两条行为：重复吊销等到离线之后才返回；一台写库失败不挡住
// 别的连接断开（成功重连之后旧连接结束不记离线，见 agents.test.ts）。写库失败用库里的触发器造。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("吊销、停用时记为离线（#878）", () => {
	const ADMIN = { loginName: "root", password: "admin-password-1" };
	let cp: TestControlPlane;
	let db: pg.Client;
	let accounts: TestAccounts;
	let adminHeaders: Record<string, string>;
	let cookie: string;
	const agents: FakeAgent[] = [];

	beforeAll(async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		accounts = new TestAccounts(cp.database.url);
		const boss = await accounts.user("boss");
		await accounts.member("default", boss, "project_admin");
		adminHeaders = bearer(await accounts.personalToken(boss));
		const login = await cp.fetch("/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
		// 名字在 test_fail 里、要写成这个状态的 UPDATE 报错；记离线失败的次数记在序列里（不随事务回滚）。
		await db.query(`
			create table test_fail (name text, status text, primary key (name, status));
			create sequence test_offline_failures;
			create function test_fail() returns trigger language plpgsql as $$
			begin
				if exists (select 1 from test_fail where name = new.name and status = new.status) then
					if new.status = 'offline' then perform nextval('test_offline_failures'); end if;
					raise exception '注入的失败：不能把 % 记为 %', new.name, new.status;
				end if;
				return new;
			end $$;
			create trigger test_fail before update on agents for each row execute function test_fail();
		`);
	}, 60_000);
	afterAll(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db?.end();
		await accounts?.close();
		await cp?.close();
	});

	const connect = async (name: string, token: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, token });
		agents.push(agent);
		return agent;
	};
	const status = async (name: string) =>
		(await db.query("select status from agents where name = $1", [name])).rows[0]?.status;
	const fail = (name: string, state: "offline" | "online") =>
		db.query("insert into test_fail (name, status) values ($1, $2)", [name, state]);
	const recover = () => db.query("delete from test_fail");
	const offlineFailures = async () =>
		Number(
			(
				await db.query(
					"select case when is_called then last_value else 0 end as n from test_offline_failures",
				)
			).rows[0]?.n,
		);
	const disable = async (name: string) =>
		(
			await cp.fetch(`/projects/default/agents/${name}/disable`, {
				method: "POST",
				headers: adminHeaders,
			})
		).status;

	/** 一台开发 Agent（凭据记在 carol 名下，按名吊销也用得上），连着。 */
	interface Case {
		name: string;
		credential: { id: string; token: string };
		agent: FakeAgent;
		carol: string;
	}
	const newCase = async (label: string): Promise<Case> => {
		const carol = await accounts.user(`carol_${label}`);
		const name = `dev-carol-${label}`;
		const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, name, {
			userId: carol,
		});
		const agent = await connect(name, issued.token);
		await eventually(async () => expect(await status(name)).toBe("online"));
		return { name, credential: { id: issued.credential.id, token: issued.token }, agent, carol };
	};
	const revoke = (c: Case) =>
		cp.current.agentCredentials.revoke(DEFAULT_PROJECT, c.name, c.credential.id);
	const revokeByName = (c: Case) =>
		cp.current.agentCredentials.revokeDev(DEFAULT_PROJECT, c.name, {
			userId: c.carol,
			canManage: false,
		});

	/**
	 * 这次写离线失败的操作。连接关掉之后它的流也会结束（detach），同样写离线失败：等到失败次数够了再往下，
	 * 免得 detach 在故障去掉之后才到、替后面的操作把离线补上。
	 */
	const failing: Record<string, (c: Case) => Promise<void>> = {
		"Agent 断开（detach）": async (c) => {
			await failedOffline(c, 1, () => c.agent.disconnect());
		},
		按凭据吊销: async (c) => {
			await failedOffline(c, 2, () => expect(revoke(c)).rejects.toThrow(/update "agents"/));
		},
		按名吊销: async (c) => {
			await failedOffline(c, 2, () => expect(revokeByName(c)).rejects.toThrow(/update "agents"/));
		},
		停用: async (c) => {
			await failedOffline(c, 2, async () => expect(await disable(c.name)).toBe(500));
		},
		"Agent 断开，同名的新连接（换了凭据）登记时写在线也失败": async (c) => {
			await failedOffline(c, 1, () => c.agent.disconnect());
			await fail(c.name, "online");
			const other = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, c.name, {
				userId: c.carol,
			});
			await expect(
				FakeAgent.connect(cp.grpcUrl, { name: c.name, token: other.token }),
			).rejects.toThrow();
		},
	};
	const failedOffline = async (c: Case, times: number, act: () => Promise<unknown>) => {
		const before = await offlineFailures();
		await fail(c.name, "offline");
		await act();
		await eventually(async () => expect(await offlineFailures()).toBe(before + times));
	};
	/** 之后碰到这个名字、这次成功的操作；返回之后有没有活着的当前连接。 */
	const following: Record<string, (c: Case) => Promise<boolean>> = {
		按凭据吊销: async (c) => {
			await revoke(c);
			return false;
		},
		按名吊销: async (c) => {
			// 同名签发了新凭据、没有用它连：本次查到的全部凭据都交给断开，旧连接的离线一并补上。
			await cp.current.agentCredentials.issue(DEFAULT_PROJECT, c.name, { userId: c.carol });
			await revokeByName(c);
			return false;
		},
		停用: async (c) => {
			expect([200, 204]).toContain(await disable(c.name));
			return false;
		},
		同名重连: async (c) => {
			const again = await connect(c.name, c.credential.token);
			expect(again.ended).toBe(false);
			return true;
		},
	};
	const cases: [string, string][] = [
		["Agent 断开（detach）", "按凭据吊销"],
		["Agent 断开（detach）", "按名吊销"],
		["Agent 断开（detach）", "停用"],
		["Agent 断开（detach）", "同名重连"],
		["按凭据吊销", "按凭据吊销"],
		["按凭据吊销", "停用"],
		["按名吊销", "按名吊销"],
		["停用", "停用"],
		["停用", "按凭据吊销"],
		["Agent 断开，同名的新连接（换了凭据）登记时写在线也失败", "按凭据吊销"],
		["Agent 断开，同名的新连接（换了凭据）登记时写在线也失败", "同名重连"],
	];

	it.each(
		cases,
	)("%s 时写库失败，之后 %s 成功：库里的 status 等于有没有活着的当前连接", async (first, then) => {
		const c = await newCase(String(cases.findIndex(([a, b]) => a === first && b === then)));
		await (failing[first] as (c: Case) => Promise<void>)(c);
		expect(await status(c.name)).toBe("online");
		await recover();
		const live = await (following[then] as (c: Case) => Promise<boolean>)(c);
		expect(await status(c.name)).toBe(live ? "online" : "offline");
	});

	it("重复吊销同一个凭据：也等断开、记为离线（onRevoked）结束才返回，不先回成功", async () => {
		const database = openDatabase(cp.database.url, () => {});
		try {
			const pending: Array<() => void> = [];
			const service = new AgentCredentialService({
				db: database.db,
				clock: cp.clock,
				onRevoked: () => new Promise<void>((resolve) => pending.push(resolve)),
			});
			const issued = await service.issue(DEFAULT_PROJECT, "worker-twice");
			const first = service.revoke(DEFAULT_PROJECT, "worker-twice", issued.credential.id);
			await eventually(async () => expect(pending).toHaveLength(1));
			let secondDone = false;
			const second = service
				.revoke(DEFAULT_PROJECT, "worker-twice", issued.credential.id)
				.then((result) => {
					secondDone = true;
					return result;
				});
			await eventually(async () => expect(pending).toHaveLength(2));
			expect(secondDone).toBe(false);
			for (const resolve of pending.splice(0)) resolve();
			expect(await first).toBe("revoked");
			expect(await second).toBe("already_revoked");
		} finally {
			await database.close();
		}
	});

	it("停用一个有两台在线开发 Agent 的用户，第一台写离线失败：第二台照样断开、记为离线", async () => {
		const alice = await accounts.user("alice");
		const first = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-alice-a", {
			userId: alice,
		});
		const second = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-alice-b", {
			userId: alice,
		});
		const a = await connect("dev-alice-a", first.token);
		const b = await connect("dev-alice-b", second.token);
		await fail("dev-alice-a", "offline");
		const disabled = await cp.fetch(`/users/${alice}/disable`, {
			method: "POST",
			headers: loginCookie(cookie),
		});
		expect(disabled.status).toBe(200);
		await eventually(async () => expect(a.ended).toBe(true));
		await eventually(async () => expect(b.ended).toBe(true));
		await eventually(async () => expect(await status("dev-alice-b")).toBe("offline"));
		expect(await status("dev-alice-a")).toBe("online");
		await recover();
	});
});
