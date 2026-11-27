// 登记工作台的前置条件和之后的连接规则（ADR 0029「迁移与过渡」，规格 #492；登记本身在 #549）：
// - 登记之前，没有停用的 Agent 必须都已经换成 Agent 凭据（按每台 Agent 最近一次连接用的是不是 Agent 凭据算）：
//   {@link agentsNotOnCredentials} 列出还没换的，登记那一步据此拒绝并列出它们；
// - 登记之后，控制面只接受 Agent 凭据：共享令牌和没有凭据的连接都拒绝（`requireAgentCredential`）。
// 存储层的入口直接用：登记状态还没有（#549），开关由测试传。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentAuth,
	AgentAuthenticator,
	agentsNotOnCredentials,
} from "../src/agents/agent-auth.js";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { AgentHub } from "../src/agents/agent-hub.js";
import { registerSharedAgentToken } from "../src/agents/shared-agent-token.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { Mutex } from "../src/util/mutex.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const INFO = { agent_version: "1.0.0", os: "linux", arch: "x86_64", slots: 1 };

describe("登记工作台：还没换成 Agent 凭据的 Agent，和登记之后的连接规则", () => {
	let testDb: TestDatabase;
	let database: Database;
	let hub: AgentHub;
	let required = false;
	let authenticator: AgentAuthenticator;
	let service: AgentCredentialService;
	const clock = new ManualClock();

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const { db } = database;
		required = false;
		hub = new AgentHub({ db, clock, mutex: new Mutex(), version: "1.0.0" });
		authenticator = new AgentAuthenticator({ db, clock, requireAgentCredential: () => required });
		service = new AgentCredentialService({
			db,
			clock,
			onRevoked: (ids) => hub.closeByCredentials(ids),
		});
	});
	afterEach(async () => {
		await database.close();
		await testDb.drop();
	});

	const connectAs = (name: string, auth: AgentAuth) =>
		hub.attach(DEFAULT_PROJECT, name, INFO, new AsyncQueue(), undefined, clock.now(), auth);

	describe("agentsNotOnCredentials", () => {
		it("没有 Agent 时为空；没带凭据、用共享令牌、记下之前连接的（没有记录）都算没换；用 Agent 凭据连上的算换了", async () => {
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual([]);
			await connectAs("a-none", { kind: "none" });
			await connectAs("b-shared", { kind: "shared" });
			await connectAs("c-agent", { kind: "agent", credentialId: crypto.randomUUID() });
			// 这一列加进来之前连接的 Agent：不知道用的什么，按没换算。
			await database.pool.query(
				"insert into agents (name, project_id, info, status, registered_at, last_seen_at) values ('d-old', 'default', '{}', 'offline', now(), now())",
			);
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual([
				"a-none",
				"b-shared",
				"d-old",
			]);
		});

		it("只签发过凭据、最近一次仍用共享令牌连接的算没换；换成凭据连上之后不再列出", async () => {
			const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
			await connectAs("worker-1", { kind: "shared" });
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual(["worker-1"]);
			await connectAs("worker-1", { kind: "agent", credentialId: issued.credential.id });
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual([]);
		});

		it("停用的 Agent 不算（不挡登记）；恢复之后又算", async () => {
			await connectAs("old-box", { kind: "none" });
			await connectAs("new-box", { kind: "agent", credentialId: crypto.randomUUID() });
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual(["old-box"]);
			await hub.setDisabled(DEFAULT_PROJECT, "old-box", true);
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual([]);
			await hub.setDisabled(DEFAULT_PROJECT, "old-box", false);
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual(["old-box"]);
		});
	});

	describe("登记之后：只接受 Agent 凭据", () => {
		it("没有登记：共享令牌、没有凭据（已登记过的名字）、Agent 凭据都能连；登记之后只剩 Agent 凭据", async () => {
			await registerSharedAgentToken(database.db, clock, "s3cret");
			await connectAs("legacy", { kind: "none" });
			const issued = await service.issue(DEFAULT_PROJECT, "worker-1");

			expect((await authenticator.authenticate("s3cret", "legacy")).ok).toBe(true);
			expect((await authenticator.authenticate(issued.token, "worker-1")).ok).toBe(true);

			required = true;
			const shared = await authenticator.authenticate("s3cret", "legacy");
			expect(shared).toMatchObject({
				ok: false,
				code: "unauthenticated",
				message: expect.stringContaining("只接受 Agent 凭据"),
			});
			expect(await authenticator.authenticate(undefined, "legacy")).toMatchObject({ ok: false });
			expect(await authenticator.authenticate(issued.token, "worker-1")).toMatchObject({
				ok: true,
				auth: { kind: "agent" },
			});
		});

		it("没有配置共享令牌时没有凭据的连接也一样被拒绝；登记状态变化之后在登记连接前的再确认里也拒绝", async () => {
			await connectAs("legacy", { kind: "none" });
			expect((await authenticator.authenticate(undefined, "legacy")).ok).toBe(true);
			required = true;
			expect(await authenticator.authenticate(undefined, "legacy")).toMatchObject({ ok: false });
			// 认身份的时候还没登记、登记之前登记了：再确认拒绝（以旧方式连接的）；带 Agent 凭据的不受影响。
			expect(
				await authenticator.recheck({ kind: "none" }, "legacy", DEFAULT_PROJECT),
			).toMatchObject({
				code: "unauthenticated",
			});
			expect(
				await authenticator.recheck({ kind: "shared" }, "legacy", DEFAULT_PROJECT),
			).toMatchObject({
				code: "unauthenticated",
			});
			const issued = await service.issue(DEFAULT_PROJECT, "worker-1");
			expect(
				await authenticator.recheck(
					{ kind: "agent", credentialId: issued.credential.id },
					"worker-1",
					DEFAULT_PROJECT,
				),
			).toBeUndefined();
		});
	});
});
