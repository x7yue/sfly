// 认身份和登记进连接表之间的空档（规格 #492）：Hello 里的凭据认过之后、连接登记之前，凭据可能被吊销、记在名下的用户可能被停用、
// 这台 Agent 可能被停用。登记之前在引擎的锁里再确认一遍（`AgentHub.attach` 的 `verify`），吊销和停用时断开已登记连接也在同一把锁里
// （`closeByCredentials`、`setDisabled`），所以不论谁先，不会有一条已经没有资格的连接留在连接表里。
// 存储层的入口直接用，不经 gRPC：空档只有几毫秒，用 gRPC 造不出确定的先后。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentAuth, AgentAuthenticator } from "../src/agents/agent-auth.js";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { AgentConnectionRefused, AgentHub } from "../src/agents/agent-hub.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { Mutex } from "../src/util/mutex.js";
import { TestAccounts } from "./support/credentials.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const INFO = { agent_version: "1.0.0", os: "linux", arch: "x86_64", slots: 1 };

describe("认身份之后、登记之前凭据或 Agent 变了：登记时再确认", () => {
	let testDb: TestDatabase;
	let database: Database;
	let accounts: TestAccounts;
	let hub: AgentHub;
	let authenticator: AgentAuthenticator;
	let service: AgentCredentialService;
	const clock = new ManualClock();

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		accounts = new TestAccounts(testDb.url);
		const { db } = database;
		hub = new AgentHub({ db, clock, mutex: new Mutex(), version: "1.0.0" });
		authenticator = new AgentAuthenticator({ db, clock });
		service = new AgentCredentialService({
			db,
			clock,
			onRevoked: (ids) => hub.closeByCredentials(ids),
		});
	});
	afterEach(async () => {
		await accounts.close();
		await database.close();
		await testDb.drop();
	});

	/** 认过身份，连接还没登记。 */
	const authenticated = async (token: string, name: string): Promise<AgentAuth> => {
		const outcome = await authenticator.authenticate(token, name);
		if (!outcome.ok) throw new Error(`认身份应该通过：${outcome.message}`);
		return outcome.auth;
	};
	const attach = (name: string, auth: AgentAuth) =>
		hub.attach(DEFAULT_PROJECT, name, INFO, new AsyncQueue(), undefined, clock.now(), auth, () =>
			authenticator.recheck(auth, name),
		);
	const registered = async () =>
		(await database.pool.query("select name from agents order by name")).rows.map(
			(r) => r.name as string,
		);

	it("认过身份之后凭据被吊销：登记被拒绝（401 一类），没有登记这台 Agent", async () => {
		const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
		const auth = await authenticated(issued.token, "worker-1");
		await service.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id);
		const refused = await attach("worker-1", auth).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(AgentConnectionRefused);
		expect(refused).toMatchObject({
			code: "unauthenticated",
			message: expect.stringContaining("吊销"),
		});
		expect(await registered()).toEqual([]);
	});

	it("认过身份之后开发 Agent 所属的用户被停用：登记被拒绝；启用之后同一个凭据可以登记", async () => {
		const owner = await accounts.user("alice");
		const issued = await service.issue(DEFAULT_PROJECT, "dev-alice-laptop", { userId: owner });
		const auth = await authenticated(issued.token, "dev-alice-laptop");
		await database.pool.query("update users set disabled_at = now() where id = $1", [owner]);
		await expect(attach("dev-alice-laptop", auth)).rejects.toMatchObject({
			code: "unauthenticated",
			message: expect.stringContaining("所属的用户已被停用"),
		});
		expect(await registered()).toEqual([]);
		await database.pool.query("update users set disabled_at = null where id = $1", [owner]);
		await attach("dev-alice-laptop", auth);
		expect(await registered()).toEqual(["dev-alice-laptop"]);
	});

	it("认过身份之后这台 Agent 被停用：登记被拒绝（403 一类）；恢复之后可以", async () => {
		const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
		const auth = await authenticated(issued.token, "worker-1");
		const first = await attach("worker-1", auth);
		expect(await hub.setDisabled(DEFAULT_PROJECT, "worker-1", true)).toBe("ok");
		expect(first.closed).toBe(true);
		await expect(attach("worker-1", auth)).rejects.toMatchObject({
			code: "permission_denied",
			message: expect.stringContaining("已被停用"),
		});
		expect(await hub.setDisabled(DEFAULT_PROJECT, "worker-1", false)).toBe("ok");
		const again = await attach("worker-1", auth);
		expect(again.closed).toBe(false);
	});

	it("吊销在登记之后：已登记的连接被断开；吊销的响应（revoke 返回）之前就已经断开", async () => {
		const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
		const other = await service.issue(DEFAULT_PROJECT, "worker-2");
		const conn = await attach("worker-1", await authenticated(issued.token, "worker-1"));
		const untouched = await attach("worker-2", await authenticated(other.token, "worker-2"));
		await service.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id);
		expect(conn.closed).toBe(true);
		expect(untouched.closed).toBe(false);
	});

	it("没有凭据的连接（过渡）没有凭据可再确认，停用的 Agent 照样拒绝", async () => {
		const none: AgentAuth = { kind: "none" };
		await attach("legacy-1", none);
		await hub.setDisabled(DEFAULT_PROJECT, "legacy-1", true);
		await expect(attach("legacy-1", none)).rejects.toBeInstanceOf(AgentConnectionRefused);
	});
});
