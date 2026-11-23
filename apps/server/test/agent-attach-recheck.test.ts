// 认身份和登记进连接表之间的空档（规格 #492）：Hello 里的凭据认过之后、连接登记之前，凭据可能被吊销、记在名下的用户可能被停用、
// 这台 Agent 可能被停用。登记之前在引擎的锁里再确认一遍（`AgentHub.attach` 的 `verify`），吊销和停用时断开已登记连接也在同一把锁里
// （`closeByCredentials`、`setDisabled`），所以不论谁先，不会有一条已经没有资格的连接留在连接表里。
// 存储层的入口直接用，不经 gRPC：空档只有几毫秒，用 gRPC 造不出确定的先后。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentAuth, AgentAuthenticator } from "../src/agents/agent-auth.js";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { AgentConnectionRefused, AgentHub } from "../src/agents/agent-hub.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
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
	const attach = (name: string, auth: AgentAuth, project: ProjectId = DEFAULT_PROJECT) =>
		hub.attach(project, name, INFO, new AsyncQueue(), undefined, clock.now(), auth, () =>
			authenticator.recheck(auth, name, project),
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

	it("认身份的时候所属用户已经被停用：认身份这一步就拒绝（不用等到登记）；别的用户的开发 Agent 不受影响", async () => {
		const alice = await accounts.user("alice");
		const bob = await accounts.user("bob");
		const aliceCred = await service.issue(DEFAULT_PROJECT, "dev-alice-laptop", { userId: alice });
		const bobCred = await service.issue(DEFAULT_PROJECT, "dev-bob-laptop", { userId: bob });
		await database.pool.query("update users set disabled_at = now() where id = $1", [alice]);
		expect(await authenticator.authenticate(aliceCred.token, "dev-alice-laptop")).toMatchObject({
			ok: false,
			code: "unauthenticated",
			message: expect.stringContaining("所属的用户已被停用"),
		});
		expect((await authenticator.authenticate(bobCred.token, "dev-bob-laptop")).ok).toBe(true);
		expect(await registered()).toEqual([]);
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
		// 没有凭据的只接受已登记过的名字：先用共享令牌（旧方式，可以登记新名字）登记。
		await attach("legacy-1", { kind: "shared" });
		await hub.setDisabled(DEFAULT_PROJECT, "legacy-1", true);
		await expect(attach("legacy-1", none)).rejects.toBeInstanceOf(AgentConnectionRefused);
	});
	it("认身份这一步就拒绝被吊销的凭据（不用等到登记前再确认）：说明写吊销，没有登记", async () => {
		const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
		await service.revoke(DEFAULT_PROJECT, "worker-1", issued.credential.id);
		expect(await authenticator.authenticate(issued.token, "worker-1")).toMatchObject({
			ok: false,
			code: "unauthenticated",
			message: expect.stringContaining("吊销"),
		});
		expect(await registered()).toEqual([]);
	});

	it("认过身份之后别的项目先登记了这个名字：后到的连接在锁里被拒绝，不会有「登记在甲、活着的却是乙的连接」", async () => {
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now())",
		);
		const mine = await service.issue(DEFAULT_PROJECT, "worker-1");
		const theirs = await service.issue("alpha" as ProjectId, "worker-1");
		const first = await authenticated(mine.token, "worker-1");
		const second = await authenticator.authenticate(theirs.token, "worker-1");
		if (!second.ok) throw new Error("认身份应该通过：名字还没有登记");
		// 默认项目的先登记；alpha 的在登记之前再确认时被拒绝（同一句「不能连接」，不透露在别的项目里）。
		const conn = await attach("worker-1", first);
		expect(conn.project).toBe("default");
		await expect(attach("worker-1", second.auth, "alpha" as ProjectId)).rejects.toMatchObject({
			code: "unauthenticated",
			message: expect.stringContaining("不能连接"),
		});
		expect(conn.closed).toBe(false);
		expect(
			(await database.pool.query("select project_id from agents where name = 'worker-1'")).rows,
		).toEqual([{ project_id: "default" }]);
		// 登记表自己也守着这条不变式，不靠调用方的再确认：不带 verify 直接登记也被拒绝。
		await expect(
			hub.attach(
				"alpha" as ProjectId,
				"worker-1",
				INFO,
				new AsyncQueue(),
				undefined,
				clock.now(),
				second.auth,
			),
		).rejects.toBeInstanceOf(AgentConnectionRefused);
		expect(conn.closed).toBe(false);
	});

	it("认过身份（旧方式）之后这个名字签发了 Agent 凭据：登记前再确认拒绝（只认凭据），和还没有登记是同一句话", async () => {
		const none: AgentAuth = { kind: "none" };
		await attach("legacy-1", { kind: "shared" });
		const before = await attach("legacy-1", none);
		expect(before.closed).toBe(false);
		await service.issue(DEFAULT_PROJECT, "legacy-1");
		const refused = await attach("legacy-1", none).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(AgentConnectionRefused);
		expect(refused).toMatchObject({
			code: "unauthenticated",
			message: expect.stringContaining("不能连接"),
		});
	});

	it("连接表里仍然保留的最后一道：以旧方式连接的不能顶掉还活着的带 Agent 凭据的同名连接（登记表自己守着，不靠认身份的前置规则）", async () => {
		const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
		const secured = await attach("worker-1", await authenticated(issued.token, "worker-1"));
		// 不带 verify 直接登记（认身份的前置规则会先挡住，这里测登记表自己的这一条）。
		await expect(
			hub.attach(DEFAULT_PROJECT, "worker-1", INFO, new AsyncQueue(), undefined, clock.now(), {
				kind: "shared",
			}),
		).rejects.toMatchObject({ message: expect.stringContaining("不能顶掉") });
		expect(secured.closed).toBe(false);
	});
});
