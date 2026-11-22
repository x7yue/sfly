// 测试里造用户、项目、成员和各种凭据：直接写库（签发凭据的接口在 #490、#491、#492），返回请求里要带的原值。
// 访问检查（src/auth/access-guard.ts）只认库里已有的凭据，所以访问检查的测试、跨项目的测试都从这里取。
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { hashCredential } from "../../src/auth/credential-hash.js";
import { SCOPES } from "../../src/auth/scopes.js";
import type { ApiTokenKind, ProjectRole } from "../../src/db/schema.js";

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
export const loginCookie = (cookie: string): Record<string, string> => ({
	cookie: `sfly_login=${cookie}`,
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

	/** 会话令牌属于一个会话（`api_tokens.session_id` 外键到 `sessions`）：先在项目里建一个会话。 */
	async sessionToken(userId: string, project: string, options: TokenOptions = {}): Promise<string> {
		const sessionId = randomUUID();
		await this.#pool.query(
			`insert into sessions (id, project_id, title, status, created_by, created_by_user_id, created_at, last_activity_at)
			values ($1, $2, '会话令牌用的会话', 'idle', '测试', $3, $4, $4)`,
			[sessionId, project, userId, AT],
		);
		return this.#token("session", "sfly_ses_", { userId, project, sessionId }, options);
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
