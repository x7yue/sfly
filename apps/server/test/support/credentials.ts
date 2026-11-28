// 测试里造用户、项目、成员和各种凭据：直接写库（不经签发的接口：个人令牌、项目令牌的签发在 tokens-http.test.ts 里经 HTTP 测），
// 返回请求里要带的原值。
// 访问检查（src/auth/access-guard.ts）只认库里已有的凭据，所以访问检查的测试、跨项目的测试都从这里取。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { hashCredential } from "../../src/auth/credential-hash.js";
import { SCOPES } from "../../src/auth/scopes.js";
import type { ApiTokenKind, ProjectRole } from "../../src/db/schema.js";
import { usableNickname } from "./sfly-cli.js";

const AT = new Date("2026-01-01T00:00:00Z");
const secret = (prefix: string) => `${prefix}${randomBytes(24).toString("hex")}`;

export interface TokenOptions {
	/** 令牌的名称（「经 …」记它）。 */
	name?: string;
	/** 令牌的范围；默认是全部范围（再和用户此刻的角色取交集）。 */
	scopes?: readonly string[];
	/** 个人令牌限定的项目。 */
	project?: string;
	expiresAt?: Date;
	revokedAt?: Date;
}

/** 凭据请求头：令牌放 `Authorization: Bearer`，登录 Cookie 放 `Cookie`。 */
export const bearer = (token: string): Record<string, string> => ({
	authorization: `Bearer ${token}`,
});
/** 登录 Cookie 只对同源的请求有效（src/auth/cross-site.ts）：测试里的请求默认是控制台页面自己发的。 */
export const loginCookie = (cookie: string): Record<string, string> => ({
	cookie: `sfly_login=${cookie}`,
	"sec-fetch-site": "same-origin",
});

export class TestAccounts {
	readonly #pool: pg.Pool;
	constructor(databaseUrl: string) {
		this.#pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	}

	close(): Promise<void> {
		return this.#pool.end();
	}

	async project(id: string): Promise<string> {
		await this.#pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, $2) on conflict do nothing",
			[id, AT],
		);
		return id;
	}

	/** 建一个用户（有密码哈希的占位串，登录不走密码）；返回用户 ID。 */
	async user(
		login: string,
		options: { displayName?: string; admin?: boolean; disabled?: boolean } = {},
	): Promise<string> {
		const id = randomUUID();
		await this.#pool.query(
			`insert into users (id, login_name, display_name, password_hash, is_platform_admin, disabled_at, created_at)
			values ($1, $2, $3, 'scrypt$placeholder', $4, $5, $6)`,
			[
				id,
				login,
				options.displayName ?? login,
				options.admin ?? false,
				options.disabled ? AT : null,
				AT,
			],
		);
		return id;
	}

	/** 这个登录名的用户：已经有就返回他的 ID（显示名等别的选项不改），没有就建。同一个库里几个测试辅助各自按昵称要用户时用。 */
	async userNamed(
		login: string,
		options: { displayName?: string; admin?: boolean } = {},
	): Promise<string> {
		// 几个测试辅助可能同时要同一个登录名的用户（各自查不到、各自去建）：插入时撞上就用已有的那一个。
		const { rows: inserted } = await this.#pool.query(
			`insert into users (id, login_name, display_name, password_hash, is_platform_admin, disabled_at, created_at)
			values ($1, $2, $3, 'scrypt$placeholder', $4, null, $5)
			on conflict (login_name) do nothing returning id`,
			[randomUUID(), login, options.displayName ?? login, options.admin ?? false, AT],
		);
		if (inserted[0] !== undefined) return inserted[0].id as string;
		const { rows } = await this.#pool.query("select id from users where login_name = $1", [login]);
		return rows[0].id as string;
	}

	async member(project: string, userId: string, role: ProjectRole): Promise<void> {
		await this.#pool.query(
			`insert into project_members (project_id, user_id, role, created_at) values ($1, $2, $3, $4)
			on conflict (project_id, user_id) do update set role = excluded.role`,
			[project, userId, role, AT],
		);
	}

	async removeMember(project: string, userId: string): Promise<void> {
		await this.#pool.query("delete from project_members where project_id = $1 and user_id = $2", [
			project,
			userId,
		]);
	}

	async disable(userId: string): Promise<void> {
		await this.#pool.query("update users set disabled_at = now() where id = $1", [userId]);
	}

	/** 登录：返回 Cookie 的值（`loginCookie` 放进请求头）。 */
	async login(
		userId: string,
		options: { idleExpiresAt?: Date; revokedAt?: Date } = {},
	): Promise<string> {
		const cookie = secret("");
		await this.#pool.query(
			`insert into logins (id, user_id, cookie_hash, created_at, last_used_at, idle_expires_at, revoked_at)
			values ($1, $2, $3, $4, $4, $5, $6)`,
			[
				randomUUID(),
				userId,
				hashCredential(cookie),
				AT,
				options.idleExpiresAt ?? new Date("2099-01-01T00:00:00Z"),
				options.revokedAt ?? null,
			],
		);
		return cookie;
	}

	async #token(
		kind: ApiTokenKind,
		prefix: string,
		fields: { userId?: string; project?: string; sessionId?: string; taskId?: string },
		options: TokenOptions,
	): Promise<string> {
		const token = secret(prefix);
		await this.#pool.query(
			`insert into api_tokens (id, kind, name, prefix, token_hash, user_id, project_id, session_id, task_id, scopes,
				created_at, expires_at, revoked_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			[
				randomUUID(),
				kind,
				options.name ?? `${kind}-token`,
				token.slice(0, 13),
				hashCredential(token),
				fields.userId ?? null,
				fields.project ?? null,
				fields.sessionId ?? null,
				fields.taskId ?? null,
				[...(options.scopes ?? SCOPES)],
				AT,
				options.expiresAt ?? null,
				options.revokedAt ?? null,
			],
		);
		return token;
	}

	/**
	 * 把一台 Agent 最近一次连接用的凭据记成这个样子（`agents.last_auth_kind`）：造「用共享令牌连接」「没有凭据」的 Agent
	 * 不必真的配共享令牌、或让一台已有 Agent 凭据的名字用旧方式连接（控制面不接受）。
	 */
	async agentAuthKind(name: string, kind: "agent" | "shared" | "none" | null): Promise<void> {
		const { rowCount } = await this.#pool.query(
			"update agents set last_auth_kind = $2 where name = $1",
			[name, kind],
		);
		if (rowCount === 0) throw new Error(`没有这台 Agent：${name}`);
	}

	/** 删掉一台 Agent 的全部凭据（造「还没有签发过凭据」的名字；真实的接口只吊销，不删行）。 */
	async clearAgentCredentials(name: string): Promise<void> {
		await this.#pool.query("delete from agent_credentials where agent_name = $1", [name]);
	}

	/** Agent 凭据行的 ID（`agent_credentials.id`）：按原值的哈希找。 */
	async agentCredentialId(token: string): Promise<string> {
		const { rows } = await this.#pool.query(
			"select id from agent_credentials where token_hash = $1",
			[hashCredential(token)],
		);
		if (rows[0] === undefined) throw new Error("没有这个 Agent 凭据");
		return rows[0].id as string;
	}

	/** 令牌行的 ID（`api_tokens.id`）：按原值的哈希找。 */
	async tokenId(token: string): Promise<string> {
		const { rows } = await this.#pool.query("select id from api_tokens where token_hash = $1", [
			hashCredential(token),
		]);
		if (rows[0] === undefined) throw new Error("没有这个令牌");
		return rows[0].id as string;
	}

	personalToken(userId: string, options: TokenOptions = {}): Promise<string> {
		return this.#token(
			"personal",
			"sfly_pat_",
			{ userId, ...(options.project ? { project: options.project } : {}) },
			options,
		);
	}

	projectToken(project: string, options: TokenOptions = {}): Promise<string> {
		return this.#token("project", "sfly_prj_", { project }, options);
	}

	/**
	 * 在项目里建一个会话（直接写库）：`turns` 是已经开始了几轮（写 `turn_started` 事件），默认一轮。
	 * 返回会话 ID。
	 */
	async session(
		userId: string,
		project: string,
		options: { title?: string; turns?: number } = {},
	): Promise<string> {
		const sessionId = randomUUID();
		await this.#pool.query(
			`insert into sessions (id, project_id, title, status, created_by, created_by_user_id, created_at, last_activity_at)
			values ($1, $2, $3, 'idle', '测试', $4, $5, $5)`,
			[sessionId, project, options.title ?? "会话令牌用的会话", userId, AT],
		);
		for (let turn = 1; turn <= (options.turns ?? 1); turn++) {
			await this.#pool.query(
				`insert into session_events (session_id, seq, type, payload, created_at)
				values ($1, $2, 'turn_started', $3, $4)`,
				[sessionId, turn, JSON.stringify({ turn }), AT],
			);
		}
		// 会话此刻在做的那一轮记在会话上（`current_turn`，#561）。
		await this.#pool.query("update sessions set current_turn = $2 where id = $1", [
			sessionId,
			options.turns ?? 1,
		]);
		return sessionId;
	}

	/** 一个已有会话的会话令牌（`api_tokens.session_id` 外键到 `sessions`）。 */
	sessionTokenIn(
		sessionId: string,
		userId: string,
		project: string,
		options: TokenOptions = {},
	): Promise<string> {
		return this.#token("session", "sfly_ses_", { userId, project, sessionId }, options);
	}

	/** 会话令牌：先在项目里建一个会话。 */
	async sessionToken(userId: string, project: string, options: TokenOptions = {}): Promise<string> {
		return this.sessionTokenIn(await this.session(userId, project), userId, project, options);
	}

	taskCredential(project: string, taskId: string, options: TokenOptions = {}): Promise<string> {
		return this.#token("task", "sfly_tsk_", { project, taskId }, options);
	}

	/** 按台签发的 Agent 凭据；开发 Agent 的凭据记在编辑者名下（`userId`）。 */
	async agentCredential(
		project: string,
		agentName: string,
		options: { revokedAt?: Date; userId?: string } = {},
	): Promise<string> {
		const token = secret("sfly_agt_");
		await this.#pool.query(
			`insert into agent_credentials (id, kind, project_id, agent_name, prefix, token_hash, user_id, created_at, revoked_at)
			values ($1, 'agent', $2, $3, $4, $5, $6, $7, $8)`,
			[
				randomUUID(),
				project,
				agentName,
				token.slice(0, 13),
				hashCredential(token),
				options.userId ?? null,
				AT,
				options.revokedAt ?? null,
			],
		);
		return token;
	}
}

/**
 * 昵称对应的登录名：合登录名格式（小写字母、数字、下划线，最多 32 个）的就用它，别的（中文、大写、空格……）用它的哈希，
 * 显示名仍是昵称原样。
 */
export const loginNameOf = (nickname: string): string =>
	/^[a-z0-9_]{1,32}$/.test(nickname)
		? nickname
		: `t_${createHash("sha256").update(nickname).digest("hex").slice(0, 24)}`;

/**
 * 测试里标记「这个请求以谁的身份发」的请求头：只在测试里用，发出去之前 {@link TestUsers.sign} 把它换成这个用户的个人令牌并去掉。
 * 控制面不认它（昵称请求头 #494 已经删掉）；没有经过签名就发出去的请求是不带凭据的。
 */
const TEST_USER_HEADER = "x-sfly-test-user";

/**
 * 以这个名字的用户发请求（#493）：测试控制面的 `fetch`、命令行和 API 客户端的辅助按它换成这个用户的个人令牌（`TestUsers`）。
 * 名字也是用户的显示名，作者、触发人记的就是它。
 */
export const actAs = (nickname: string): Record<string, string> => ({
	[TEST_USER_HEADER]: encodeURIComponent(nickname),
});

/** 测试里的请求默认是谁（#493）：没有用 {@link actAs} 时就是他。 */
export const DEFAULT_TESTER = "tester";

/** 请求以谁的身份发（{@link actAs} 写进去的名字）：没写是 tester，解不开的编码是 undefined。 */
export function nicknameIn(headers: Headers): string | undefined {
	const raw = headers.get(TEST_USER_HEADER);
	if (raw === null) return DEFAULT_TESTER;
	try {
		return decodeURIComponent(raw);
	} catch {
		return undefined;
	}
}

/**
 * 测试控制面默认带的凭据（#493，`TestControlPlane.fetch`）：每个昵称一个用户（显示名是昵称）和他的个人令牌，第一次用到时
 * 直接写库建出来。用户是平台管理员，也是默认项目的项目管理员：#494 之前不带凭据的请求哪个项目都能读写，平台管理员也是；
 * 他是默认项目的成员，在默认项目里的写不记进 `platform_admin_actions`（在别的项目里的写会记）。
 * 要普通成员、只读、别的项目的凭据时用 {@link TestAccounts} 自己建。
 */
export class TestUsers {
	readonly #databaseUrl: string;
	readonly #users = new Map<string, Promise<{ id: string; token: string }>>();
	readonly #ready = new Map<string, string>();

	constructor(databaseUrl: string) {
		this.#databaseUrl = databaseUrl;
	}

	/** 每次写库用一个自己的连接池，用完就关：库可能在测试里被删掉（健康检查的用例），不留空闲的连接。 */
	async #withAccounts<T>(work: (accounts: TestAccounts) => Promise<T>): Promise<T> {
		const accounts = new TestAccounts(this.#databaseUrl);
		try {
			return await work(accounts);
		} finally {
			await accounts.close();
		}
	}

	/** 这个昵称的用户（没有就建）。昵称要能当显示名（不空、不超过 64 个字符、没有控制字符等），不然建不出来。 */
	user(nickname = DEFAULT_TESTER): Promise<{ id: string; token: string }> {
		let found = this.#users.get(nickname);
		if (found === undefined) {
			found = this.#withAccounts(async (accounts) => {
				const id = await accounts.userNamed(loginNameOf(nickname), {
					displayName: nickname,
					admin: true,
				});
				await accounts.member("default", id, "project_admin");
				const token = await accounts.personalToken(id, { name: "测试" });
				this.#ready.set(nickname, token);
				return { id, token };
			});
			// 建失败了（例如库还是旧的结构）不留在表里，下次再试。
			found.catch(() => this.#users.delete(nickname));
			this.#users.set(nickname, found);
		}
		return found;
	}

	/** 让这个昵称的用户也是这个项目的成员（项目不存在时先建）。 */
	async joinProject(nickname: string, project: string, role: ProjectRole): Promise<void> {
		const { id } = await this.user(nickname);
		await this.#withAccounts(async (accounts) => {
			await accounts.project(project);
			await accounts.member(project, id, role);
		});
	}

	/**
	 * 显示名是这个昵称的普通成员（不是平台管理员，只在 `project` 里有 `role`）新登录一次，返回登录 Cookie 的值。
	 * 登录名和默认凭据的用户分开（`m_` 开头），两者可以同时存在。
	 */
	async memberLogin(nickname: string, project: string, role: ProjectRole): Promise<string> {
		return this.#withAccounts(async (accounts) => {
			const id = await accounts.userNamed(loginNameOf(`m_${nickname}`), { displayName: nickname });
			await accounts.project(project);
			await accounts.member(project, id, role);
			return accounts.login(id);
		});
	}

	/** 这个昵称的用户新登录一次，返回登录 Cookie 的值（e2e 的浏览器带它就是登录着的）。 */
	async loginCookie(nickname = DEFAULT_TESTER): Promise<string> {
		const { id } = await this.user(nickname);
		return this.#withAccounts((accounts) => accounts.login(id));
	}

	/** 以这个昵称的用户发请求要带的请求头（`authorization`）。 */
	async as(nickname: string): Promise<Record<string, string>> {
		return bearer(await this.token(nickname));
	}

	/** 已经建出来的这个昵称的个人令牌（同步，给起子进程的地方用）；还没建时为 undefined。 */
	tokenNow(nickname: string | undefined): string | undefined {
		return this.#ready.get(nickname ?? DEFAULT_TESTER);
	}

	/** 这个昵称的个人令牌原值。 */
	async token(nickname: string | undefined = DEFAULT_TESTER): Promise<string> {
		return (await this.user(nickname ?? DEFAULT_TESTER)).token;
	}

	/** 请求要带的请求头：自己带了凭据、或 `credentials: "omit"` 时原样返回。 */
	async sign(init: RequestInit): Promise<Headers> {
		const headers = new Headers(init.headers);
		const nickname = nicknameIn(headers);
		headers.delete(TEST_USER_HEADER);
		if (init.credentials === "omit" || headers.has("authorization") || headers.has("cookie")) {
			return headers;
		}
		// 昵称本身不合格（测的就是控制面怎么拒绝它）：不带凭据，照旧是不带凭据的请求。
		if (nickname === undefined || !usableNickname(nickname)) return headers;
		headers.set("authorization", `Bearer ${await this.token(nickname)}`);
		return headers;
	}
}
