// 用户、项目、成员、令牌、登录、Agent 凭据的表结构（ADR 0029，规格 #487）：约束放在库里，
// 之后的任务（登录、令牌、Agent 凭据）往里写数据时，不合格的行在库里就被拒绝。
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsDir, openDatabase } from "../src/db/database.js";
import { parseProjectId } from "../src/projects/project-id.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const AT = "2026-01-01T00:00:00Z";
let testDb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
	testDb = await createTestDatabase();
	const database = openDatabase(testDb.url, () => {}, defaultMigrationsDir);
	await database.migrate();
	await database.close();
	client = new pg.Client({ connectionString: testDb.url });
	await client.connect();
});
afterAll(async () => {
	await client.end();
	await testDb.drop();
});

const hex = () => randomUUID().replaceAll("-", "").repeat(2);

async function addUser(
	fields: { login?: string; password?: string | null; external?: string | null } = {},
): Promise<string> {
	const id = randomUUID();
	await client.query(
		`insert into users (id, login_name, display_name, password_hash, external_identity, created_at)
		values ($1, $2, '显示名', $3, $4, $5)`,
		[
			id,
			fields.login ?? id.slice(0, 8).replaceAll("-", "_"),
			fields.password === undefined ? "scrypt$stored" : fields.password,
			fields.external ?? null,
			AT,
		],
	);
	return id;
}

describe("用户", () => {
	it("登录名只能是小写字母、数字、下划线，长度 1–32：不含连字符，也不含大写和空白", async () => {
		for (const login of ["a", "alice", "a_b", "user_01", "_", "0", "x".repeat(32)]) {
			await expect(addUser({ login }), login).resolves.toBeTypeOf("string");
		}
		for (const login of [
			"",
			"a-b",
			"Alice",
			"x".repeat(33),
			"a b",
			"a\n",
			"\na",
			"用户",
			"a.b",
			"a@b",
		]) {
			await expect(addUser({ login }), JSON.stringify(login)).rejects.toThrow(
				/users_login_name_format/,
			);
		}
	});

	it("登录名唯一", async () => {
		await addUser({ login: "dup_name" });
		await expect(addUser({ login: "dup_name" })).rejects.toThrow(/users_login_name/);
	});

	it("没有密码的用户必须有外部身份，外部身份唯一，没有外部身份的用户不受唯一约束", async () => {
		await expect(addUser({ password: null })).rejects.toThrow(/users_can_authenticate/);
		await addUser({ password: null, external: "oidc|alice" });
		await expect(addUser({ external: "oidc|alice" })).rejects.toThrow(/users_external_identity/);
		await addUser();
		await addUser();
	});

	it("新用户默认不是平台管理员、没有停用", async () => {
		const id = await addUser();
		const { rows } = await client.query(
			"select is_platform_admin, disabled_at from users where id = $1",
			[id],
		);
		expect(rows).toEqual([{ is_platform_admin: false, disabled_at: null }]);
	});
});

describe("项目与成员", () => {
	const addProject = (id: string) =>
		client.query("insert into projects (id, display_name, created_at) values ($1, $1, $2)", [
			id,
			AT,
		]);

	it("项目标识：小写字母、数字、连字符，不以连字符开头，最长 63 个字符", async () => {
		// 代码里的 parseProjectId 和库里的约束是同一条规则：每个样本两边的结论一致。
		for (const project of ["alpha", "a-b", "team-2", "0", "a".repeat(63)]) {
			await expect(addProject(project), project).resolves.toBeDefined();
			expect(parseProjectId(project), project).toBe(project);
		}
		for (const project of ["", "Alpha", "-a", "a_b", "a b", "a".repeat(64), "a\n", "项目"]) {
			await expect(addProject(project), JSON.stringify(project)).rejects.toThrow(
				/projects_id_format/,
			);
			expect(parseProjectId(project), JSON.stringify(project)).toBeUndefined();
		}
	});

	it("成员：角色只能是只读、编辑者、项目管理员；同一个用户在同一个项目里只有一个身份；项目和用户必须存在", async () => {
		await addProject("members-a");
		const user = await addUser();
		const add = (project: string, who: string, role: string) =>
			client.query(
				"insert into project_members (project_id, user_id, role, created_at) values ($1, $2, $3, $4)",
				[project, who, role, AT],
			);
		for (const [i, role] of ["read_only", "editor", "project_admin"].entries()) {
			await addProject(`members-r${i}`);
			await expect(add(`members-r${i}`, user, role), role).resolves.toBeDefined();
		}
		await expect(add("members-a", user, "owner")).rejects.toThrow(/project_members_role/);
		await add("members-a", user, "editor");
		await expect(add("members-a", user, "read_only")).rejects.toThrow(
			/project_members_pkey|duplicate key/,
		);
		await expect(add("no-such-project", user, "editor")).rejects.toThrow(
			/project_members_project_id_projects_id_fk/,
		);
		await expect(add("members-a", randomUUID(), "editor")).rejects.toThrow(
			/project_members_user_id_users_id_fk/,
		);
	});
});

describe("令牌", () => {
	const user = () => addUser();
	const insert = (fields: {
		kind: string;
		user?: string | null;
		project?: string | null;
		session?: string | null;
		task?: string | null;
		hash?: string;
	}) =>
		client.query(
			`insert into api_tokens (id, kind, name, prefix, token_hash, user_id, project_id, session_id, task_id, scopes, created_at)
			values ($1, $2, '令牌', 'sfly_xxx_ab12', $3, $4, $5, $6, $7, '{read}', $8)`,
			[
				randomUUID(),
				fields.kind,
				fields.hash ?? hex(),
				fields.user ?? null,
				fields.project ?? null,
				fields.session ?? null,
				fields.task ?? null,
				AT,
			],
		);

	it("四种令牌各自用到哪些列由约束保证", async () => {
		const owner = await user();
		// 个人令牌：属于用户，可以限定一个项目。
		await insert({ kind: "personal", user: owner });
		await insert({ kind: "personal", user: owner, project: "default" });
		await expect(insert({ kind: "personal" })).rejects.toThrow(/api_tokens_shape/);
		await expect(insert({ kind: "personal", user: owner, session: randomUUID() })).rejects.toThrow(
			/api_tokens_shape/,
		);
		// 项目令牌：属于项目，没有用户。
		await insert({ kind: "project", project: "default" });
		await expect(insert({ kind: "project" })).rejects.toThrow(/api_tokens_shape/);
		await expect(insert({ kind: "project", project: "default", user: owner })).rejects.toThrow(
			/api_tokens_shape/,
		);
		// 会话令牌：代发起人、限一个项目、属于一个会话。
		await insert({ kind: "session", user: owner, project: "default", session: randomUUID() });
		await expect(insert({ kind: "session", user: owner, project: "default" })).rejects.toThrow(
			/api_tokens_shape/,
		);
		await expect(insert({ kind: "session", user: owner, session: randomUUID() })).rejects.toThrow(
			/api_tokens_shape/,
		);
		await expect(
			insert({ kind: "session", project: "default", session: randomUUID() }),
		).rejects.toThrow(/api_tokens_shape/);
		// 任务凭据：限本项目、属于一次任务尝试，没有用户。
		await insert({ kind: "task", project: "default", task: randomUUID() });
		await expect(insert({ kind: "task", project: "default" })).rejects.toThrow(/api_tokens_shape/);
		await expect(
			insert({ kind: "task", project: "default", task: randomUUID(), user: owner }),
		).rejects.toThrow(/api_tokens_shape/);
	});

	it("种类只能是个人、项目、会话、任务；哈希唯一；项目和用户必须存在", async () => {
		const owner = await user();
		await expect(insert({ kind: "agent", user: owner })).rejects.toThrow(/api_tokens_kind/);
		const hash = hex();
		await insert({ kind: "personal", user: owner, hash });
		await expect(insert({ kind: "personal", user: owner, hash })).rejects.toThrow(
			/api_tokens_hash/,
		);
		await expect(insert({ kind: "project", project: "no-such-project" })).rejects.toThrow(
			/api_tokens_project_id_projects_id_fk/,
		);
		await expect(insert({ kind: "personal", user: randomUUID() })).rejects.toThrow(
			/api_tokens_user_id_users_id_fk/,
		);
	});
});

describe("登录", () => {
	it("Cookie 的哈希唯一，登录属于一个存在的用户", async () => {
		const owner = await addUser();
		const login = (userId: string, cookieHash: string) =>
			client.query(
				`insert into logins (id, user_id, cookie_hash, created_at, last_used_at, idle_expires_at)
				values ($1, $2, $3, $4, $4, $4)`,
				[randomUUID(), userId, cookieHash, AT],
			);
		const hash = hex();
		await login(owner, hash);
		await expect(login(owner, hash)).rejects.toThrow(/logins_cookie_hash/);
		await expect(login(randomUUID(), hex())).rejects.toThrow(/logins_user_id_users_id_fk/);
	});
});

describe("Agent 凭据", () => {
	const insert = (fields: {
		kind: string;
		name?: string | null;
		prefix?: string | null;
		user?: string | null;
		project?: string;
		hash?: string;
	}) =>
		client.query(
			`insert into agent_credentials (id, kind, project_id, agent_name, prefix, token_hash, user_id, created_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				randomUUID(),
				fields.kind,
				fields.project ?? "default",
				fields.name ?? null,
				fields.prefix ?? null,
				fields.hash ?? hex(),
				fields.user ?? null,
				AT,
			],
		);

	it("按台签发的凭据有 Agent 名字，开发 Agent 的凭据记在编辑者名下；旧式共享令牌不限名字、没有用户", async () => {
		const editor = await addUser();
		await insert({ kind: "agent", name: "agent-a", prefix: "sfly_agt_ab12" });
		await insert({
			kind: "agent",
			name: "dev-alice-laptop",
			prefix: "sfly_agt_cd34",
			user: editor,
		});
		// 轮换期间同一台 Agent 可以有几个有效的凭据。
		await insert({ kind: "agent", name: "agent-a", prefix: "sfly_agt_ef56" });
		await insert({ kind: "shared" });
		await expect(insert({ kind: "agent", prefix: "sfly_agt_x" })).rejects.toThrow(
			/agent_credentials_shape/,
		);
		await expect(insert({ kind: "agent", name: "agent-a" })).rejects.toThrow(
			/agent_credentials_shape/,
		);
		await expect(insert({ kind: "shared", name: "agent-a" })).rejects.toThrow(
			/agent_credentials_shape/,
		);
		await expect(insert({ kind: "shared", user: editor })).rejects.toThrow(
			/agent_credentials_shape/,
		);
		await expect(insert({ kind: "other" })).rejects.toThrow(/agent_credentials_kind/);
	});

	it("哈希唯一；项目必须存在", async () => {
		const hash = hex();
		await insert({ kind: "shared", hash });
		await expect(insert({ kind: "shared", hash })).rejects.toThrow(/agent_credentials_hash/);
		await expect(insert({ kind: "shared", project: "no-such-project" })).rejects.toThrow(
			/agent_credentials_project_id_projects_id_fk/,
		);
	});
});

describe("运行的项目恒等于它的场景的项目", () => {
	const addProject = (id: string) =>
		client.query("insert into projects (id, display_name, created_at) values ($1, $1, $2)", [
			id,
			AT,
		]);

	/** 在 `project` 里直接插入一个场景和它的第一个版本，返回两者的 ID。 */
	async function addScenario(project: string): Promise<{ scenario: string; version: string }> {
		const scenario = randomUUID();
		const version = randomUUID();
		await client.query(
			"insert into orchestrations (id, project_id, name, head_version, created_at) values ($1, $2, '场景', 1, $3)",
			[scenario, project, AT],
		);
		await client.query(
			"insert into orchestration_versions (id, orchestration_id, number, document, author, created_at) values ($1, $2, 1, '{}', '测试', $3)",
			[version, scenario, AT],
		);
		return { scenario, version };
	}

	const addRun = (scenario: string, version: string, project: string) => {
		const id = randomUUID();
		return client
			.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
				values ($1, $2, $3, $4, '测试', '{}', 'success', $5)`,
				[id, scenario, version, project, AT],
			)
			.then(() => id);
	};

	const projectOfRun = async (id: string) =>
		(await client.query("select project_id from runs where id = $1", [id])).rows[0]?.project_id;

	it("运行的项目和场景的项目一致才写得进去；不一致被组合外键拒绝，项目不存在也一样", async () => {
		await addProject("fk-a");
		await addProject("fk-b");
		const { scenario, version } = await addScenario("fk-a");
		await expect(addRun(scenario, version, "fk-a")).resolves.toBeTypeOf("string");
		await expect(addRun(scenario, version, "fk-b")).rejects.toThrow(
			/runs_orchestration_project_fk/,
		);
		await expect(addRun(scenario, version, "default")).rejects.toThrow(
			/runs_orchestration_project_fk/,
		);
		await expect(addRun(scenario, version, "no-such-project")).rejects.toThrow(
			/runs_orchestration_project_fk/,
		);
		await expect(addRun(randomUUID(), version, "fk-a")).rejects.toThrow(
			/runs_orchestration_project_fk/,
		);
	});

	it("场景的项目改了，它的运行跟着改（ON UPDATE CASCADE），别的场景的运行不动", async () => {
		await addProject("move-from");
		await addProject("move-to");
		const moved = await addScenario("move-from");
		const stays = await addScenario("move-from");
		const runs = [
			await addRun(moved.scenario, moved.version, "move-from"),
			await addRun(moved.scenario, moved.version, "move-from"),
		];
		const other = await addRun(stays.scenario, stays.version, "move-from");

		await client.query("update orchestrations set project_id = 'move-to' where id = $1", [
			moved.scenario,
		]);

		for (const run of runs) expect(await projectOfRun(run)).toBe("move-to");
		expect(await projectOfRun(other)).toBe("move-from");
	});

	it("不再有只管场景或只管项目的单独外键（项目存在由场景的外键间接保证）", async () => {
		const { rows } = await client.query(
			`select conname from pg_constraint where conrelid = 'runs'::regclass and contype = 'f' order by conname`,
		);
		expect(rows.map((r) => r.conname)).toEqual([
			"runs_cancel_requested_by_user_id_users_id_fk",
			"runs_orchestration_project_fk",
			"runs_orchestration_version_id_orchestration_versions_id_fk",
			"runs_triggered_by_user_id_users_id_fk",
		]);
	});
});

describe("Agent 最近一次连接用的凭据", () => {
	const addAgent = (name: string, kind: string | null) =>
		client.query(
			`insert into agents (name, project_id, info, status, registered_at, last_seen_at, last_auth_kind)
			values ($1, 'default', '{}', 'online', $2, $2, $3)`,
			[name, AT, kind],
		);

	it("只能是没带凭据（none）、共享令牌（shared）、按台签发的 Agent 凭据（agent），或者空（记下之前连接的 Agent）", async () => {
		for (const kind of ["none", "shared", "agent", null]) {
			await expect(addAgent(`auth-${kind}`, kind), String(kind)).resolves.toBeDefined();
		}
		for (const kind of ["", "credential", "Agent", "token", "none "]) {
			await expect(addAgent(`bad-${kind}`, kind), JSON.stringify(kind)).rejects.toThrow(
				/agents_last_auth_kind/,
			);
		}
	});

	it("取值和 agent_credentials.kind 一致：两张表里的「agent」「shared」是同一个意思", async () => {
		const { rows } = await client.query(
			`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agent_credentials_kind'`,
		);
		expect(rows[0].def).toMatch(/'agent'.*'shared'|'shared'.*'agent'/);
	});
});
