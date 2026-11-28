// 吊销、停用时把 Agent 记为离线（#878）的边界：重复的吊销也等断开之后才返回；写离线失败时能补记；
// 批量断开时一台写库失败不挡住别的连接断开。写库失败用库里的触发器造：把这些名字记为离线的 UPDATE 报错。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("吊销、停用时记为离线的边界（#878）", () => {
	let cp: TestControlPlane;
	let db: pg.Client;
	let accounts: TestAccounts;
	const agents: FakeAgent[] = [];
	const ADMIN = { loginName: "root", password: "admin-password-1" };

	const start = async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		accounts = new TestAccounts(cp.database.url);
		await db.query(`
			create table test_fail_offline (name text primary key);
			create function test_fail_offline() returns trigger language plpgsql as $$
			begin
				if new.status = 'offline' and exists (select 1 from test_fail_offline where name = new.name) then
					raise exception '注入的失败：不能把 % 记为离线', new.name;
				end if;
				return new;
			end $$;
			create trigger test_fail_offline before update on agents
				for each row execute function test_fail_offline();
		`);
	};
	afterEach(async () => {
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
	const failOffline = (name: string) =>
		db.query("insert into test_fail_offline (name) values ($1)", [name]);
	const recover = () => db.query("delete from test_fail_offline");
	const admin = async () => {
		const id = await accounts.user("boss");
		await accounts.member("default", id, "project_admin");
		return bearer(await accounts.personalToken(id));
	};

	it("重复吊销同一个凭据：也等断开、记为离线（onRevoked）结束才返回，不先回成功", async () => {
		await start();
		const database = openDatabase(cp.database.url, () => {});
		try {
			const pending: Array<() => void> = [];
			const service = new AgentCredentialService({
				db: database.db,
				clock: cp.clock,
				onRevoked: () => new Promise<void>((resolve) => pending.push(resolve)),
			});
			const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
			const first = service.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id);
			await eventually(async () => expect(pending).toHaveLength(1));

			let secondDone = false;
			const second = service
				.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id)
				.then((result) => {
					secondDone = true;
					return result;
				});
			await eventually(async () => expect(pending).toHaveLength(2));
			expect(secondDone).toBe(false);
			for (const resolve of pending.splice(0)) resolve();
			expect(await first).toBe("revoked");
			expect(await second).toBe("already_revoked");

			// 开发 Agent 的凭据全都吊销过时同样：再吊销一次也等断开。
			const alice = await accounts.user("alice");
			await service.issue(DEFAULT_PROJECT, "dev-alice-laptop", { userId: alice });
			const by = { userId: alice, canManage: false };
			const devFirst = service.revokeDev(DEFAULT_PROJECT, "dev-alice-laptop", by);
			await eventually(async () => expect(pending).toHaveLength(1));
			pending.splice(0)[0]?.();
			expect(await devFirst).toEqual({ kind: "revoked" });
			const devAgain = service.revokeDev(DEFAULT_PROJECT, "dev-alice-laptop", by);
			await eventually(async () => expect(pending).toHaveLength(1));
			pending.splice(0)[0]?.();
			expect(await devAgain).toEqual({ kind: "already_revoked" });
		} finally {
			await database.close();
		}
	});

	it("停用时写离线失败：响应报错；之后重试停用（unchanged）补记离线，列表是离线；同名的新连接不会被补记成离线", async () => {
		await start();
		const headers = await admin();
		const toggle = async (action: "disable" | "enable") =>
			(await cp.fetch(`/projects/default/agents/worker-1/${action}`, { method: "POST", headers }))
				.status;
		const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "worker-1");
		const agent = await connect("worker-1", issued.token);

		await failOffline("worker-1");
		expect(await toggle("disable")).toBe(500);
		await eventually(async () => expect(agent.ended).toBe(true));
		expect(await status("worker-1")).toBe("online");

		await recover();
		expect(await toggle("disable")).toBe(204);
		expect(await status("worker-1")).toBe("offline");

		// 恢复之后同名的新连接上线：之前留下的离线记账已经补完，不会再把它记成离线。
		expect(await toggle("enable")).toBe(204);
		const again = await connect("worker-1", issued.token);
		await eventually(async () => expect(await status("worker-1")).toBe("online"));
		expect(again.ended).toBe(false);
	});

	it("停用一个有两台在线开发 Agent 的用户，第一台写离线失败：第二台照样断开、记为离线；第一台之后补记", async () => {
		await start();
		const alice = await accounts.user("alice");
		const first = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-alice-a", {
			userId: alice,
		});
		const second = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "dev-alice-b", {
			userId: alice,
		});
		const a = await connect("dev-alice-a", first.token);
		const b = await connect("dev-alice-b", second.token);
		const login = await cp.fetch("/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		const cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";

		await failOffline("dev-alice-a");
		const disabled = await cp.fetch(`/users/${alice}/disable`, {
			method: "POST",
			headers: loginCookie(cookie),
		});
		expect(disabled.status).toBe(200);
		await eventually(async () => expect(a.ended).toBe(true));
		await eventually(async () => expect(b.ended).toBe(true));
		await eventually(async () => expect(await status("dev-alice-b")).toBe("offline"));
		expect(await status("dev-alice-a")).toBe("online");

		// 第一台的离线之后补记：再吊销它的凭据（重复的吊销也补记）。
		await recover();
		await cp.current.agentCredentials.revoke(DEFAULT_PROJECT, "dev-alice-a", first.credential.id);
		expect(await status("dev-alice-a")).toBe("offline");
	});
});
