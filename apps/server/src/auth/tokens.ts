// 个人令牌和项目令牌的签发、列出、吊销（ADR 0029「凭据」）。不依赖 Fastify：HTTP 路由（src/http/token-routes.ts）把请求翻成
// 这里的调用，再把结果翻回响应。
//
// 库里只存原值的 SHA-256 哈希（./credential-hash.ts）和前缀；原值只在签发时返回一次，之后任何接口都读不回，
// 也不写进日志（这个文件里没有任何日志输出）。令牌只吊销、不删除：「经 …」按令牌的名称记在运行和场景版本上。
import { randomBytes, randomUUID } from "node:crypto";
import { TOKEN_PREFIXES, type TokenView } from "@sfly/schema";
import { and, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { apiTokens, projectMembers, projects } from "../db/schema.js";
import { type ProjectId, parseProjectId } from "../projects/project-id.js";
import { hashCredential } from "./credential-hash.js";
import type { RevocationBus } from "./revocations.js";
import {
	PLATFORM_ADMIN_SCOPES,
	PROJECT_TOKEN_SCOPES,
	ROLE_SCOPES,
	SCOPES,
	type Scope,
} from "./scopes.js";

/**
 * 一个所有者名下同时有效（没吊销、没过期）的令牌数量上限：令牌签发是人（登录）或账号密码才能做的，这个上限只是不让
 * 一个被偷走的登录无限签发令牌、也不让列表无限长；正常使用远到不了。
 */
export const MAX_ACTIVE_TOKENS = 100;

/** 令牌原值里随机部分的字节数：24 字节（192 位），十六进制 48 个字符；前面是种类前缀（`sfly_pat_`、`sfly_prj_`）。 */
const SECRET_BYTES = 24;
/** 展示用的前缀长度：种类前缀（9 个字符）加原值开头的 4 个字符。 */
const PREFIX_LENGTH = 13;

const DAY_MS = 86_400_000;

type TokenRow = typeof apiTokens.$inferSelect;

/** 刚签发的令牌：视图加原值（原值只在这一次出现）。 */
export interface IssuedTokenRecord {
	view: TokenView;
	token: string;
}

export type IssueFailure =
	/** 限定的项目不存在，或者他不是成员（不是平台管理员）：说法一样，不泄露项目有没有。 */
	| { ok: false; reason: "project_not_found" }
	/** 他还不是任何项目的成员，没有可以签发的范围。 */
	| { ok: false; reason: "no_scopes" }
	/** 要的范围超过了他此刻能有的；`excess` 是超出的那几个。 */
	| { ok: false; reason: "scope_exceeds_role"; excess: Scope[]; allowed: Scope[] }
	/** 项目令牌自己不能带「管理」：成员和角色的管理只能由人做。 */
	| { ok: false; reason: "manage_scope_not_allowed" }
	| { ok: false; reason: "name_taken" }
	| { ok: false; reason: "too_many_tokens" };

export type IssueResult = { ok: true; issued: IssuedTokenRecord } | IssueFailure;

export interface TokenServiceOptions {
	db: Db;
	clock: Clock;
	/** 吊销的广播：吊销一个令牌时通知路由层关掉用它打开的事件流。 */
	revocations: RevocationBus;
}

/** 随机的令牌原值：种类前缀加 192 位随机数的十六进制。 */
const newSecret = (prefix: string): string =>
	`${prefix}${randomBytes(SECRET_BYTES).toString("hex")}`;

const toView = (row: TokenRow, currentTokenId: string | null = null): TokenView => ({
	id: row.id,
	kind: row.kind === "project" ? "project" : "personal",
	name: row.name,
	prefix: row.prefix,
	scopes: row.scopes,
	project: row.projectId,
	created_at: row.createdAt.toISOString(),
	expires_at: row.expiresAt?.toISOString() ?? null,
	revoked_at: row.revokedAt?.toISOString() ?? null,
	last_used_at: row.lastUsedAt?.toISOString() ?? null,
	current: row.id === currentTokenId,
});

export class TokenService {
	readonly #db: Db;
	readonly #clock: Clock;
	readonly #revocations: RevocationBus;

	constructor(options: TokenServiceOptions) {
		this.#db = options.db;
		this.#clock = options.clock;
		this.#revocations = options.revocations;
	}

	// ---- 范围：签出的范围不超过签发人此刻的角色 ----

	/**
	 * 一个用户签发个人令牌时此刻能有的范围：限定了项目的看他在那个项目里的角色（平台管理员在存在的项目里是项目管理员），
	 * 没限定的看他在所有项目里的角色加起来（平台管理员是全部）。使用时再和他那时的角色取交集（访问检查），
	 * 所以这里只是「签发时不超过」，不是「永远等于」。
	 * 限定的项目不存在、或他不是成员也不是平台管理员：返回 undefined（调用方回 404）。
	 */
	async allowedScopes(
		user: { id: string; isPlatformAdmin: boolean },
		project: ProjectId | null,
	): Promise<Scope[] | undefined> {
		if (project !== null) {
			if (user.isPlatformAdmin) {
				const found = await this.#db
					.select({ id: projects.id })
					.from(projects)
					.where(eq(projects.id, project));
				return found.length > 0 ? [...PLATFORM_ADMIN_SCOPES] : undefined;
			}
			const [member] = await this.#db
				.select({ role: projectMembers.role })
				.from(projectMembers)
				.where(and(eq(projectMembers.projectId, project), eq(projectMembers.userId, user.id)));
			return member === undefined ? undefined : [...ROLE_SCOPES[member.role]];
		}
		if (user.isPlatformAdmin) return [...PLATFORM_ADMIN_SCOPES];
		const roles = await this.#db
			.select({ role: projectMembers.role })
			.from(projectMembers)
			.where(eq(projectMembers.userId, user.id));
		const held = new Set<Scope>(roles.flatMap(({ role }) => ROLE_SCOPES[role]));
		return SCOPES.filter((scope) => held.has(scope));
	}

	// ---- 签发 ----

	/**
	 * 签发个人令牌。`scopes` 不写是他此刻能有的全部范围；写了的不能超过它（`scope_exceeds_role`）。
	 * 同名的有效令牌已经有了是 `name_taken`；有效的令牌到了上限是 `too_many_tokens`。
	 */
	async issuePersonal(
		user: { id: string; isPlatformAdmin: boolean },
		input: { name: string; scopes?: readonly Scope[]; project?: string; expiresInDays?: number },
	): Promise<IssueResult> {
		let project: ProjectId | null = null;
		if (input.project !== undefined) {
			project = parseProjectId(input.project) ?? null;
			if (project === null) return { ok: false, reason: "project_not_found" };
		}
		const allowed = await this.allowedScopes(user, project);
		if (allowed === undefined) return { ok: false, reason: "project_not_found" };
		if (allowed.length === 0) return { ok: false, reason: "no_scopes" };
		const scopes = input.scopes === undefined ? allowed : [...new Set(input.scopes)];
		const excess = scopes.filter((scope) => !allowed.includes(scope));
		if (excess.length > 0) return { ok: false, reason: "scope_exceeds_role", excess, allowed };
		return this.#insert({
			kind: "personal",
			owner: `personal:${user.id}`,
			ownedBy: eq(apiTokens.userId, user.id),
			name: input.name,
			scopes,
			userId: user.id,
			projectId: project,
			expiresInDays: input.expiresInDays,
		});
	}

	/**
	 * 签发项目令牌：范围不能带「管理」（`manage_scope_not_allowed`），也不能超过签发人（这次请求）此刻的范围
	 * （`scope_exceeds_role`；`issuerScopes` 是访问检查得出的有效范围）。同名和上限同个人令牌，按项目算。
	 */
	async issueProject(
		project: ProjectId,
		input: { name: string; scopes: readonly Scope[]; expiresInDays?: number },
		issuerScopes: readonly Scope[],
	): Promise<IssueResult> {
		if (input.scopes.includes("manage")) return { ok: false, reason: "manage_scope_not_allowed" };
		const allowed = issuerScopes.filter((scope) => PROJECT_TOKEN_SCOPES.includes(scope));
		const excess = input.scopes.filter((scope) => !allowed.includes(scope));
		if (excess.length > 0) return { ok: false, reason: "scope_exceeds_role", excess, allowed };
		return this.#insert({
			kind: "project",
			owner: `project:${project}`,
			ownedBy: eq(apiTokens.projectId, project),
			name: input.name,
			scopes: [...new Set(input.scopes)],
			userId: null,
			projectId: project,
			expiresInDays: input.expiresInDays,
		});
	}

	async #insert(input: {
		kind: "personal" | "project";
		/** 同名和上限都按所有者算：个人令牌是用户，项目令牌是项目。`owner` 是串行化用的键，`ownedBy` 是查所有者名下令牌的条件。 */
		owner: string;
		ownedBy: SQL;
		name: string;
		scopes: readonly Scope[];
		userId: string | null;
		projectId: ProjectId | null;
		expiresInDays: number | undefined;
	}): Promise<IssueResult> {
		const now = this.#clock.now();
		const secret = newSecret(TOKEN_PREFIXES[input.kind]);
		return this.#db.transaction(async (tx) => {
			// 同一个所有者的签发串行化：名字和数量的检查之后、插入之前，别的签发不能插进来。
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`token:${input.owner}`}))`);
			const active = await tx
				.select({ name: apiTokens.name })
				.from(apiTokens)
				.where(
					and(
						eq(apiTokens.kind, input.kind),
						input.ownedBy,
						isNull(apiTokens.revokedAt),
						or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
					),
				);
			if (active.some((row) => row.name === input.name)) return { ok: false, reason: "name_taken" };
			if (active.length >= MAX_ACTIVE_TOKENS) return { ok: false, reason: "too_many_tokens" };
			const [row] = await tx
				.insert(apiTokens)
				.values({
					id: randomUUID(),
					kind: input.kind,
					name: input.name,
					prefix: secret.slice(0, PREFIX_LENGTH),
					tokenHash: hashCredential(secret),
					userId: input.userId,
					projectId: input.projectId,
					scopes: [...input.scopes],
					createdAt: now,
					expiresAt:
						input.expiresInDays === undefined
							? null
							: new Date(now.getTime() + input.expiresInDays * DAY_MS),
				})
				.returning();
			if (row === undefined) throw new Error("签发令牌没有返回行");
			return { ok: true, issued: { view: toView(row), token: secret } };
		});
	}

	// ---- 列出 ----

	/** 一个用户的个人令牌（含已吊销、已过期的，新的在前）；`currentTokenId` 是发起请求用的那一个（用 Cookie 时为 null）。 */
	async listPersonal(userId: string, currentTokenId: string | null): Promise<TokenView[]> {
		const rows = await this.#db
			.select()
			.from(apiTokens)
			.where(and(eq(apiTokens.kind, "personal"), eq(apiTokens.userId, userId)))
			.orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
		return rows.map((row) => toView(row, currentTokenId));
	}

	/** 一个项目的项目令牌（含已吊销、已过期的，新的在前）。 */
	async listProject(project: ProjectId): Promise<TokenView[]> {
		const rows = await this.#db
			.select()
			.from(apiTokens)
			.where(and(eq(apiTokens.kind, "project"), eq(apiTokens.projectId, project)))
			.orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
		return rows.map((row) => toView(row));
	}

	// ---- 吊销 ----

	/** 吊销一个用户自己的个人令牌：不存在或不是他的返回 false；已经吊销的算成功（幂等）。 */
	async revokePersonal(userId: string, tokenId: string): Promise<boolean> {
		return this.#revoke(and(eq(apiTokens.kind, "personal"), eq(apiTokens.userId, userId)), tokenId);
	}

	/** 吊销一个项目的项目令牌：不存在或不在这个项目里返回 false；已经吊销的算成功（幂等）。 */
	async revokeProject(project: ProjectId, tokenId: string): Promise<boolean> {
		return this.#revoke(
			and(eq(apiTokens.kind, "project"), eq(apiTokens.projectId, project)),
			tokenId,
		);
	}

	async #revoke(owned: SQL | undefined, tokenId: string): Promise<boolean> {
		const [found] = await this.#db
			.select({ id: apiTokens.id })
			.from(apiTokens)
			.where(and(eq(apiTokens.id, tokenId), owned));
		if (found === undefined) return false;
		// 只记第一次吊销的时间；并发的两次吊销只有一次写成功，也只广播一次。
		const revoked = await this.#db
			.update(apiTokens)
			.set({ revokedAt: this.#clock.now() })
			.where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
			.returning({ id: apiTokens.id });
		if (revoked.length > 0) this.#revocations.emit({ type: "token", tokenId });
		return true;
	}
}
