import { randomUUID } from "node:crypto";
// 项目的工作台：登记、前置条件、开关从库里得出、检查和登记之间的竞争（ADR 0029「迁移与过渡」，#549）。
// 存储层的入口直接用（真实的 PostgreSQL，不经 HTTP）：登记在引擎的锁里做，和连接的登记（`AgentHub.attach`）互斥，
// 所以先后两种顺序都能确定地造出来：谁先排进锁，谁先做完。HTTP 一侧（范围、响应、重启、Hello 的拒绝）在 project-workbench-http.test.ts。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentAuth,
	AgentAuthenticator,
	agentsNotOnCredentials,
} from "../src/agents/agent-auth.js";
import { AgentCredentialService } from "../src/agents/agent-credentials.js";
import { AgentConnectionRefused, AgentHub } from "../src/agents/agent-hub.js";
import { registerSharedAgentToken } from "../src/agents/shared-agent-token.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
import { ProjectWorkbench } from "../src/projects/project-workbench.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { Mutex } from "../src/util/mutex.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const INFO = { agent_version: "1.0.0", os: "linux", arch: "x86_64", slots: 1 };
const ALPHA = "alpha" as ProjectId;

describe("项目的工作台", () => {
	let testDb: TestDatabase;
	let database: Database;
	let mutex: Mutex;
	let hub: AgentHub;
	let workbench: ProjectWorkbench;
	let authenticator: AgentAuthenticator;
	let credentials: AgentCredentialService;
	const clock = new ManualClock();
	/** 登记的人：平台管理员（开关还没开时只有平台管理员能登记，#778）。 */
	const admin = { userId: randomUUID() };

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const { db } = database;
		mutex = new Mutex();
		hub = new AgentHub({ db, clock, mutex, version: "1.0.0" });
		workbench = new ProjectWorkbench({ db, mutex });
		await database.pool.query(
			"insert into users (id, login_name, display_name, password_hash, is_platform_admin, created_at) values ($1, 'root', 'root', 'scrypt$placeholder', true, now())",
			[admin.userId],
		);
		authenticator = new AgentAuthenticator({
			db,
			clock,
			requireAgentCredential: () => workbench.credentialRequired(),
		});
		credentials = new AgentCredentialService({
			db,
			clock,
			onRevoked: (ids) => hub.closeByCredentials(ids),
		});
	});
	afterEach(async () => {
		await database.close();
		await testDb.drop();
	});

	const attach = (name: string, auth: AgentAuth, project: ProjectId = DEFAULT_PROJECT) =>
		hub.attach(project, name, INFO, new AsyncQueue(), undefined, clock.now(), auth, () =>
			authenticator.recheck(auth, name, project),
		);
	/** 把一台 Agent 登记进库（不做连接前的再确认）：「没有凭据」的连接只接受已登记过的名字，新名字要这样先放进去。 */
	const seed = (name: string, auth: AgentAuth) =>
		hub.attach(DEFAULT_PROJECT, name, INFO, new AsyncQueue(), undefined, clock.now(), auth);
	/** 用自己的 Agent 凭据连上来：签发、连接，返回连接。 */
	const connectOnCredential = async (name: string) => {
		const issued = await credentials.issue(DEFAULT_PROJECT, name);
		return attach(name, { kind: "agent", credentialId: issued.credential.id });
	};
	const agentRow = async (name: string) =>
		(
			await database.pool.query(
				"select project_id, last_auth_kind, disabled_at from agents where name = $1",
				[name],
			)
		).rows[0] as
			| { project_id: string; last_auth_kind: string | null; disabled_at: Date | null }
			| undefined;
	const column = async (project: string) =>
		(await database.pool.query("select workbench_agent from projects where id = $1", [project]))
			.rows[0]?.workbench_agent as string | null | undefined;

	describe("登记的前置条件", () => {
		it("部署里有没换成 Agent 凭据的 Agent（共享令牌、没有凭据、记下之前连接的）：拒绝并列出它们，库里没有登记", async () => {
			await connectOnCredential("wb");
			await attach("b-shared", { kind: "shared" });
			await seed("a-none", { kind: "none" });
			// 这一列加进来之前连接的 Agent：不知道用的什么，按没换算。
			await database.pool.query(
				"insert into agents (name, project_id, info, status, registered_at, last_seen_at) values ('c-old', 'default', '{}', 'offline', now(), now())",
			);
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toEqual({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["a-none", "b-shared", "c-old"],
				otherProjects: 0,
			});
			expect(await column("default")).toBeNull();
			expect(await workbench.credentialRequired()).toBe(false);
		});

		it("签发了 Agent 凭据、最近一次仍用共享令牌连接的挡登记；只签发过、没用它连上过的不挡；换成凭据连上之后不再挡", async () => {
			await connectOnCredential("wb");
			await attach("worker-1", { kind: "shared" });
			const issued = await credentials.issue(DEFAULT_PROJECT, "worker-1");
			// 另一台：签发了凭据，从来没连上过，库里没有它的行。
			await credentials.issue(DEFAULT_PROJECT, "never-connected");
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["worker-1"],
			});
			await attach("worker-1", { kind: "agent", credentialId: issued.credential.id });
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({ ok: true });
		});

		it("停用的 Agent 不挡登记；恢复之后又挡（第一次登记之前）", async () => {
			await connectOnCredential("wb");
			await seed("old-box", { kind: "none" });
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["old-box"],
			});
			await hub.setDisabled(DEFAULT_PROJECT, "old-box", true);
			await hub.setDisabled(DEFAULT_PROJECT, "old-box", false);
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["old-box"],
			});
			await hub.setDisabled(DEFAULT_PROJECT, "old-box", true);
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({ ok: true });
		});

		it("工作台本身：没有这台 Agent、属于别的项目（和没有一样）、被停用、最近一次连接不是 Agent 凭据，各是各的拒绝", async () => {
			await database.pool.query(
				"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now())",
			);
			const alphaCredential = await credentials.issue(ALPHA, "in-alpha");
			await attach(
				"in-alpha",
				{ kind: "agent", credentialId: alphaCredential.credential.id },
				ALPHA,
			);
			await connectOnCredential("off");
			await hub.setDisabled(DEFAULT_PROJECT, "off", true);
			await attach("shared-one", { kind: "shared" });

			const reason = async (name: string) => {
				const outcome = await workbench.register(DEFAULT_PROJECT, name, admin);
				return outcome.ok ? "ok" : outcome.reason;
			};
			expect(await reason("nobody")).toBe("agent_unknown");
			// 别的项目里的名字：和不存在是同一个回应，不透露那边有没有它。
			expect(await reason("in-alpha")).toBe("agent_unknown");
			expect(await reason("off")).toBe("agent_disabled");
			expect(await reason("shared-one")).toBe("agent_not_on_credential");
			expect(await column("default")).toBeNull();
		});
	});

	describe("开关已经开着时换工作台：不再要求整个部署都换成 Agent 凭据，工作台本身的条件照旧", () => {
		it("登记之后，一台旧方式的 Agent 被停用再恢复（留着 shared 记录，反正连不上）不挡换工作台；第一次登记时它挡", async () => {
			await connectOnCredential("wb-1");
			await connectOnCredential("wb-2");
			await seed("legacy", { kind: "shared" });
			// 第一次登记（开关还没开）：它挡。
			expect(await workbench.register(DEFAULT_PROJECT, "wb-1", admin)).toMatchObject({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["legacy"],
			});
			await hub.setDisabled(DEFAULT_PROJECT, "legacy", true);
			expect(await workbench.register(DEFAULT_PROJECT, "wb-1", admin)).toMatchObject({ ok: true });
			// 恢复它：库里留着它登记之前的最后一次记录（shared），`agentsNotOnCredentials` 又列出它；
			// 登记之后它的旧方式 Hello 被拒绝，所以这条记录不该挡住换工作台。
			await hub.setDisabled(DEFAULT_PROJECT, "legacy", false);
			expect((await agentsNotOnCredentials(database.db)).map((a) => a.name)).toEqual(["legacy"]);
			expect(await workbench.register(DEFAULT_PROJECT, "wb-2", admin)).toEqual({
				ok: true,
				project: DEFAULT_PROJECT,
				agent: "wb-2",
				previous: "wb-1",
			});
			expect(await column("default")).toBe("wb-2");
		});

		it("工作台本身的三条照旧：没有这台 Agent、被停用、最近一次连接不是 Agent 凭据，开关开着时也一样拒绝，库里还是原来的工作台", async () => {
			await connectOnCredential("wb-1");
			await workbench.register(DEFAULT_PROJECT, "wb-1", admin);
			await connectOnCredential("off");
			await hub.setDisabled(DEFAULT_PROJECT, "off", true);
			// 登记之后旧方式进不来，造一条登记之前留下的 shared 记录（直接写库）。
			await database.pool.query(
				"insert into agents (name, project_id, info, status, registered_at, last_seen_at, last_auth_kind) values ('shared-one', 'default', '{}', 'offline', now(), now(), 'shared')",
			);
			const reason = async (name: string) => {
				const outcome = await workbench.register(DEFAULT_PROJECT, name, admin);
				return outcome.ok ? "ok" : outcome.reason;
			};
			expect(await reason("nobody")).toBe("agent_unknown");
			expect(await reason("off")).toBe("agent_disabled");
			expect(await reason("shared-one")).toBe("agent_not_on_credential");
			expect(await column("default")).toBe("wb-1");
		});
	});

	describe("读不到开关：拒绝，不放行", () => {
		/** 让 `projects.workbench_agent` 这一列读不了（开关读库的那条查询失败），返回恢复它的函数。 */
		const breakTheSwitch = async () => {
			await database.pool.query(
				"alter table projects rename column workbench_agent to workbench_gone",
			);
			return () =>
				database.pool.query("alter table projects rename column workbench_gone to workbench_agent");
		};

		it("开关读库失败时，旧方式的 Hello（共享令牌、没有凭据）抛出去、连接不登记；不会当成「没有登记」放行；恢复之后照常", async () => {
			await registerSharedAgentToken(database.db, clock, "s3cret");
			await seed("legacy", { kind: "none" });
			const restore = await breakTheSwitch();
			await expect(workbench.credentialRequired()).rejects.toThrow();
			// 认身份：读开关的那一条查询抛出来，不是 ok、也不是一个「没有登记」的结果。
			await expect(authenticator.authenticate("s3cret", "legacy")).rejects.toThrow();
			await expect(authenticator.authenticate(undefined, "legacy")).rejects.toThrow();
			// 登记连接之前的再确认也一样：抛出来，`attach` 没有把这条连接放进连接表。
			await expect(attach("legacy-2", { kind: "shared" })).rejects.toThrow();
			expect(hub.connection("legacy-2")).toBeUndefined();
			expect(await agentRow("legacy-2")).toBeUndefined();
			await restore();
			expect((await authenticator.authenticate("s3cret", "legacy")).ok).toBe(true);
		});

		it("带 Agent 凭据的 Hello 不读开关：开关读不了时照常（认凭据本来就有它自己的读库）", async () => {
			const issued = await credentials.issue(DEFAULT_PROJECT, "worker-1");
			const restore = await breakTheSwitch();
			expect(await authenticator.authenticate(issued.token, "worker-1")).toMatchObject({
				ok: true,
				auth: { kind: "agent" },
			});
			await restore();
		});
	});

	describe("登记、换工作台、开关", () => {
		it("登记：写进项目的那一列，开关打开；换一台工作台返回换下来的那台，登记同一台是幂等的（没有换）", async () => {
			await connectOnCredential("wb-1");
			await connectOnCredential("wb-2");
			expect(await workbench.get(DEFAULT_PROJECT)).toBeUndefined();
			expect(await workbench.credentialRequired()).toBe(false);

			expect(await workbench.register(DEFAULT_PROJECT, "wb-1", admin)).toEqual({
				ok: true,
				project: DEFAULT_PROJECT,
				agent: "wb-1",
				previous: null,
			});
			expect(await column("default")).toBe("wb-1");
			expect(await workbench.get(DEFAULT_PROJECT)).toBe("wb-1");
			expect(await workbench.credentialRequired()).toBe(true);

			expect(await workbench.register(DEFAULT_PROJECT, "wb-1", admin)).toMatchObject({
				ok: true,
				previous: null,
			});
			expect(await workbench.register(DEFAULT_PROJECT, "wb-2", admin)).toMatchObject({
				ok: true,
				agent: "wb-2",
				previous: "wb-1",
			});
			expect(await workbench.get(DEFAULT_PROJECT)).toBe("wb-2");
			expect(await workbench.credentialRequired()).toBe(true);
		});

		it("开关从库里得出：换一个实例（模拟控制面重启）照样是打开的；库里的那一列清空（回退）之后才关", async () => {
			await connectOnCredential("wb");
			await workbench.register(DEFAULT_PROJECT, "wb", admin);
			const restarted = new ProjectWorkbench({ db: database.db, mutex: new Mutex() });
			expect(await restarted.credentialRequired()).toBe(true);
			expect(await restarted.get(DEFAULT_PROJECT)).toBe("wb");
			const after = new AgentAuthenticator({
				db: database.db,
				clock,
				requireAgentCredential: () => restarted.credentialRequired(),
			});
			await registerSharedAgentToken(database.db, clock, "s3cret");
			expect(await after.authenticate("s3cret", "anyone")).toMatchObject({
				ok: false,
				code: "unauthenticated",
				message: expect.stringContaining("只接受 Agent 凭据"),
			});
			await database.pool.query("update projects set workbench_agent = null");
			expect(await restarted.credentialRequired()).toBe(false);
			expect((await after.authenticate("s3cret", "anyone")).ok).toBe(true);
		});

		it("部署里任何一个项目登记了工作台，开关就是打开的（整个部署，不只这个项目）", async () => {
			await database.pool.query(
				"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now())",
			);
			const issued = await credentials.issue(ALPHA, "alpha-wb");
			await attach("alpha-wb", { kind: "agent", credentialId: issued.credential.id }, ALPHA);
			expect(await workbench.register(ALPHA, "alpha-wb", admin)).toMatchObject({ ok: true });
			expect(await workbench.get(DEFAULT_PROJECT)).toBeUndefined();
			expect(await workbench.credentialRequired()).toBe(true);
			await registerSharedAgentToken(database.db, clock, "s3cret");
			// 默认项目没有登记工作台，它的共享令牌连接照样被拒绝。
			expect(await authenticator.authenticate("s3cret", "legacy")).toMatchObject({ ok: false });
		});

		it("登记不碰已有的连接：带 Agent 凭据的连接登记之后还连着", async () => {
			const conn = await connectOnCredential("wb");
			const other = await connectOnCredential("worker-2");
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({ ok: true });
			expect(conn.closed).toBe(false);
			expect(other.closed).toBe(false);
		});
	});

	describe("登记的范围（#778）：整个部署的开关只给平台管理员，没换凭据的 Agent 只列这个项目里的", () => {
		const projectAdmin = async () => {
			const id = randomUUID();
			await database.pool.query(
				"insert into users (id, login_name, display_name, password_hash, is_platform_admin, created_at) values ($1, 'boss', 'boss', 'scrypt$placeholder', false, now())",
				[id],
			);
			return { userId: id };
		};
		const alphaAgent = async (name: string) => {
			const issued = await credentials.issue(ALPHA, name);
			return attach(name, { kind: "agent", credentialId: issued.credential.id }, ALPHA);
		};
		beforeEach(async () => {
			await database.pool.query(
				"insert into projects (id, display_name, created_at) values ('alpha', 'alpha', now())",
			);
		});

		it("开关还没开时项目管理员登记不了（不改任何东西）；平台管理员登记之后开关开着，项目管理员能登记自己项目的工作台", async () => {
			const boss = await projectAdmin();
			await alphaAgent("alpha-wb");
			expect(await workbench.register(ALPHA, "alpha-wb", boss)).toEqual({
				ok: false,
				reason: "switch_needs_platform_admin",
			});
			expect(await column("alpha")).toBeNull();
			expect(await workbench.credentialRequired()).toBe(false);
			// 没有用户的调用方（不该走到这里）也一样。
			expect(await workbench.register(ALPHA, "alpha-wb", { userId: null })).toMatchObject({
				reason: "switch_needs_platform_admin",
			});

			await connectOnCredential("wb");
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({ ok: true });
			expect(await workbench.register(ALPHA, "alpha-wb", boss)).toMatchObject({ ok: true });
			expect(await column("alpha")).toBe("alpha-wb");
		});

		it("没换凭据的 Agent 只列这个项目里的名字，别的项目里的只给台数", async () => {
			await connectOnCredential("wb");
			await seed("here-old", { kind: "none" });
			await hub.attach(ALPHA, "there-1", INFO, new AsyncQueue(), undefined, clock.now(), {
				kind: "none",
			});
			await hub.attach(ALPHA, "there-2", INFO, new AsyncQueue(), undefined, clock.now(), {
				kind: "none",
			});
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toEqual({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["here-old"],
				otherProjects: 2,
			});
			// 这个项目里的都换了、别的项目里还有：照样挡（开关是整个部署的），名字一个都不给。
			await hub.setDisabled(DEFAULT_PROJECT, "here-old", true);
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toEqual({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: [],
				otherProjects: 2,
			});
		});
	});

	describe("检查和登记之间的竞争：两步在引擎的锁里，和连接的登记互斥", () => {
		/** 占住引擎的锁，返回放行的函数：之后排队的操作按排队的先后依次做。 */
		const hold = () => {
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const held = mutex.run(() => gate);
			return { release: () => release(), held };
		};

		it("旧方式的连接先排进锁：它登记之后，登记的检查（在锁里重新读）看到它，拒绝并列出它，没有登记", async () => {
			await connectOnCredential("wb");
			const { release, held } = hold();
			const attaching = attach("legacy", { kind: "shared" });
			const registering = workbench.register(DEFAULT_PROJECT, "wb", admin);
			release();
			await held;
			await attaching;
			expect(await registering).toEqual({
				ok: false,
				reason: "agents_not_on_credentials",
				agents: ["legacy"],
				otherProjects: 0,
			});
			expect(await column("default")).toBeNull();
			expect(await workbench.credentialRequired()).toBe(false);
			expect((await agentRow("legacy"))?.last_auth_kind).toBe("shared");
		});

		it("登记先排进锁：登记生效之后，旧方式的连接在锁里的再确认被拒绝，不进连接表、不留 Agent 的行", async () => {
			await connectOnCredential("wb");
			const { release, held } = hold();
			const registering = workbench.register(DEFAULT_PROJECT, "wb", admin);
			const attaching = attach("legacy", { kind: "shared" });
			const refused = expect(attaching).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof AgentConnectionRefused &&
					error.code === "unauthenticated" &&
					error.message.includes("只接受 Agent 凭据"),
			);
			release();
			await held;
			expect(await registering).toMatchObject({ ok: true });
			await refused;
			expect(hub.connection("legacy")).toBeUndefined();
			expect(await agentRow("legacy")).toBeUndefined();
			// 没带凭据的连接也一样。
			await expect(attach("legacy-2", { kind: "none" })).rejects.toBeInstanceOf(
				AgentConnectionRefused,
			);
		});

		it("认身份（锁外）通过之后、登记生效：连接登记之前的再确认拒绝它（认身份和登记之间开关变了）", async () => {
			await connectOnCredential("wb");
			await registerSharedAgentToken(database.db, clock, "s3cret");
			// 此刻还没有登记：共享令牌认得过。
			const outcome = await authenticator.authenticate("s3cret", "legacy");
			expect(outcome).toMatchObject({ ok: true, auth: { kind: "shared" } });
			expect(await workbench.register(DEFAULT_PROJECT, "wb", admin)).toMatchObject({ ok: true });
			if (!outcome.ok) throw new Error("unreachable");
			await expect(attach("legacy", outcome.auth, outcome.project)).rejects.toBeInstanceOf(
				AgentConnectionRefused,
			);
			expect(hub.connection("legacy")).toBeUndefined();
		});

		it("反复同时做（先后交替）：登记和旧方式的连接同时来，结果总是二选一——登记成功时旧方式的连接进不来，旧方式的连接进来时登记被拒绝并列出它", async () => {
			const results: string[] = [];
			for (let round = 0; round < 12; round++) {
				await database.pool.query("update projects set workbench_agent = null");
				await database.pool.query("delete from agents");
				await connectOnCredential(`wb-${round}`);
				const legacy = `legacy-${round}`;
				// 偶数轮登记先排进锁，奇数轮旧方式的连接先排进锁：两种顺序各六次。
				const registerFirst = round % 2 === 0;
				const doRegister = () => workbench.register(DEFAULT_PROJECT, `wb-${round}`, admin);
				const doAttach = () => attach(legacy, { kind: "shared" });
				let registered: PromiseSettledResult<Awaited<ReturnType<typeof doRegister>>>;
				let attached: PromiseSettledResult<unknown>;
				if (registerFirst) {
					[registered, attached] = await Promise.allSettled([doRegister(), doAttach()]);
				} else {
					[attached, registered] = await Promise.allSettled([doAttach(), doRegister()]);
				}
				if (registered.status !== "fulfilled") throw registered.reason;
				const register = registered.value;
				if (register.ok) {
					expect(attached.status, `第 ${round} 轮：登记成功时旧方式的连接不能进来`).toBe(
						"rejected",
					);
					expect(await agentRow(legacy)).toBeUndefined();
					results.push("registered");
				} else {
					expect(register).toMatchObject({ reason: "agents_not_on_credentials", agents: [legacy] });
					expect(attached.status, `第 ${round} 轮：登记被拒绝时旧方式的连接已经在`).toBe(
						"fulfilled",
					);
					results.push("refused");
				}
			}
			expect(results.filter((result) => result === "registered")).toHaveLength(6);
			expect(results.filter((result) => result === "refused")).toHaveLength(6);
		}, 60_000);
	});
});
