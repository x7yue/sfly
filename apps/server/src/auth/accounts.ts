// 本地账号：建用户、初始化第一个管理员、登录、登出、改密码、停用、重置密码（ADR 0029「用户、项目与角色」「认证的几处细节」）。
// 不依赖 Fastify：HTTP 路由（src/http/account-routes.ts）把请求翻成这里的调用，再把结果翻回响应。
// 登录 Cookie 只存哈希（./credential-hash.ts）；密码用 scrypt（./password.ts）。
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { logins, type ProjectRole, projectMembers, users } from "../db/schema.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";
import { DEFAULT_LOGIN_IDLE_MS } from "./access-guard.js";
import { hashCredential } from "./credential-hash.js";
import { LoginThrottle } from "./login-throttle.js";
import {
	DEFAULT_SCRYPT,
	hashPassword,
	needsRehash,
	type ScryptParams,
	verifyPassword,
} from "./password.js";
import type { SetupCode } from "./setup-code.js";

/** 一个用户（不含密码哈希）。 */
export interface UserRecord {
	id: string;
	loginName: string;
	displayName: string;
	isPlatformAdmin: boolean;
	disabledAt: Date | null;
	createdAt: Date;
}

/** 登录成功：用户，和要下发的 Cookie 原值（只在这一次出现，库里只有它的哈希）。 */
export interface LoggedIn {
	user: UserRecord;
	cookie: string;
	/** Cookie 的空闲期限（秒）。 */
	maxAgeSeconds: number;
}

/**
 * 一批登录或令牌被注销、用户被停用：打开着的事件流要跟着关掉（单进程，按登录和用户登记即可）。
 * `user`：这个用户的一切（停用：登录和令牌）；`logins`：这个用户的登录（`only` 只这一个，`except` 除了这一个）。
 */
export type Revocation =
	| { type: "user"; userId: string }
	| { type: "logins"; userId: string; only?: string; except?: string };

export interface AccountServiceOptions {
	db: Db;
	clock: Clock;
	/** 初始化码；没有时 `setup` 一律失败。 */
	setupCode?: SetupCode;
	/** 密码哈希的参数，默认 {@link DEFAULT_SCRYPT}；测试里调小。 */
	scrypt?: ScryptParams;
	/** 登录的空闲期限（毫秒），默认 12 小时。 */
	loginIdleMs?: number;
	throttle?: LoginThrottle;
}

/** 登录名重复。 */
export class LoginNameTaken extends Error {
	constructor(name: string) {
		super(`登录名 ${name} 已经有人用了`);
	}
}

const toRecord = (row: typeof users.$inferSelect): UserRecord => ({
	id: row.id,
	loginName: row.loginName,
	displayName: row.displayName,
	isPlatformAdmin: row.isPlatformAdmin,
	disabledAt: row.disabledAt,
	createdAt: row.createdAt,
});

const isUniqueViolation = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	((error as { code?: string }).code === "23505" ||
		isUniqueViolation((error as { cause?: unknown }).cause));

/** 事务里串行化「只有没有任何用户时才能初始化」用的建议锁的键。 */
const SETUP_LOCK = 4_904_900_001;

export class AccountService {
	readonly #db: Db;
	readonly #clock: Clock;
	readonly #scrypt: ScryptParams;
	readonly #idleMs: number;
	readonly #throttle: LoginThrottle;
	readonly #setupCode: SetupCode | undefined;
	readonly #listeners = new Set<(revocation: Revocation) => void>();
	#dummy: Promise<string> | undefined;

	constructor(options: AccountServiceOptions) {
		this.#db = options.db;
		this.#clock = options.clock;
		this.#scrypt = options.scrypt ?? DEFAULT_SCRYPT;
		this.#idleMs = options.loginIdleMs ?? DEFAULT_LOGIN_IDLE_MS;
		this.#throttle = options.throttle ?? new LoginThrottle(options.clock);
		this.#setupCode = options.setupCode;
	}

	/** 登录的空闲期限（秒）：下发 Cookie 时的 Max-Age。 */
	get idleSeconds(): number {
		return Math.floor(this.#idleMs / 1000);
	}

	/** 登录被注销、用户被停用时调用（路由层据此关掉打开的事件流）。返回取消订阅的函数。 */
	onRevoked(listener: (revocation: Revocation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#revoked(revocation: Revocation): void {
		for (const listener of this.#listeners) listener(revocation);
	}

	// ---- 状态与初始化 ----

	/** 还没有任何用户：要先初始化第一个管理员。 */
	async setupRequired(): Promise<boolean> {
		const [row] = await this.#db.select({ n: count() }).from(users);
		return (row?.n ?? 0) === 0;
	}

	/**
	 * 用初始化码建第一个平台管理员（同时是默认项目的项目管理员：他在默认项目里的写不算「平台管理员在不是成员的项目里」的操作），
	 * 并登录。已经有用户时是 `setup_done`；码不对或没有可用的码是 `bad_code`（算失败，按来源地址限速）。
	 */
	async setup(
		input: { code: string; loginName: string; displayName: string; password: string },
		address: string,
	): Promise<
		| { ok: true; login: LoggedIn }
		| { ok: false; reason: "setup_done" | "bad_code" }
		| { ok: false; reason: "throttled"; retryAfterMs: number }
	> {
		if (!(await this.setupRequired())) return { ok: false, reason: "setup_done" };
		const wait = this.#throttle.retryAfterMs("setup", address);
		if (wait > 0) return { ok: false, reason: "throttled", retryAfterMs: wait };
		if (!this.#setupCode?.verify(input.code)) {
			this.#throttle.failure("setup", address);
			return { ok: false, reason: "bad_code" };
		}
		const passwordHash = await hashPassword(input.password, this.#scrypt);
		const created = await this.#createFirstAdmin({ ...input, passwordHash });
		if (created === undefined) return { ok: false, reason: "setup_done" };
		this.#throttle.success("setup", address);
		await this.#setupCode.discard();
		return { ok: true, login: await this.#startLogin(created) };
	}

	/** 没有任何用户时建第一个平台管理员；已经有用户时返回 undefined（并发的两次初始化只有一次成功）。 */
	async #createFirstAdmin(input: {
		loginName: string;
		displayName: string;
		passwordHash: string;
	}): Promise<UserRecord | undefined> {
		return this.#db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
			const [row] = await tx.select({ n: count() }).from(users);
			if ((row?.n ?? 0) > 0) return undefined;
			const now = this.#clock.now();
			const [created] = await tx
				.insert(users)
				.values({
					id: randomUUID(),
					loginName: input.loginName,
					displayName: input.displayName,
					passwordHash: input.passwordHash,
					isPlatformAdmin: true,
					createdAt: now,
				})
				.returning();
			if (created === undefined) throw new Error("建用户没有返回行");
			await tx.insert(projectMembers).values({
				projectId: DEFAULT_PROJECT,
				userId: created.id,
				role: "project_admin" satisfies ProjectRole,
				createdAt: now,
			});
			return toRecord(created);
		});
	}

	/** 用环境变量给出的初始管理员（自动化部署和测试）：没有任何用户时才建；返回有没有建。 */
	async createInitialAdmin(input: {
		loginName: string;
		displayName: string;
		password: string;
	}): Promise<boolean> {
		const passwordHash = await hashPassword(input.password, this.#scrypt);
		return (await this.#createFirstAdmin({ ...input, passwordHash })) !== undefined;
	}

	// ---- 登录与登出 ----

	/** 一个不存在的用户也要花同样的时间验证一次密码，响应时间不泄露「登录名有没有这个人」。 */
	#dummyHash(): Promise<string> {
		this.#dummy ??= hashPassword(randomBytes(16).toString("hex"), this.#scrypt);
		return this.#dummy;
	}

	/** 密码对不对；没有存储的密码（用户不存在、只靠外部身份登录）也要花同样的时间验证一次，响应时间不泄露这一点。 */
	async #passwordMatches(password: string, stored: string | undefined): Promise<boolean> {
		if (stored !== undefined) return verifyPassword(password, stored);
		await verifyPassword(password, await this.#dummyHash());
		return false;
	}

	async login(
		loginName: string,
		password: string,
		address: string,
	): Promise<
		| { ok: true; login: LoggedIn }
		| { ok: false; reason: "invalid" }
		| { ok: false; reason: "throttled"; retryAfterMs: number }
	> {
		const name = loginName.trim().toLowerCase();
		const wait = this.#throttle.retryAfterMs(name, address);
		if (wait > 0) return { ok: false, reason: "throttled", retryAfterMs: wait };
		const [row] = await this.#db.select().from(users).where(eq(users.loginName, name));
		const stored = row?.passwordHash ?? undefined;
		const correct = await this.#passwordMatches(password, stored);
		// 停用的账号和密码不对一样：不告诉对方账号是否存在、是否停用。
		if (row === undefined || !correct || row.disabledAt !== null) {
			this.#throttle.failure(name, address);
			return { ok: false, reason: "invalid" };
		}
		this.#throttle.success(name, address);
		// 参数调高之后，旧哈希在这次登录成功时按新参数重新存。
		if (stored !== undefined && needsRehash(stored, this.#scrypt)) {
			await this.#db
				.update(users)
				.set({ passwordHash: await hashPassword(password, this.#scrypt) })
				.where(eq(users.id, row.id));
		}
		return { ok: true, login: await this.#startLogin(toRecord(row)) };
	}

	async #startLogin(user: UserRecord): Promise<LoggedIn> {
		const cookie = randomBytes(32).toString("base64url");
		const now = this.#clock.now();
		await this.#db.insert(logins).values({
			id: randomUUID(),
			userId: user.id,
			cookieHash: hashCredential(cookie),
			createdAt: now,
			lastUsedAt: now,
			idleExpiresAt: new Date(now.getTime() + this.#idleMs),
		});
		return { user, cookie, maxAgeSeconds: this.idleSeconds };
	}

	/** 登出：注销这一个登录。 */
	async logout(userId: string, loginId: string): Promise<void> {
		await this.#db
			.update(logins)
			.set({ revokedAt: this.#clock.now() })
			.where(and(eq(logins.id, loginId), eq(logins.userId, userId), isNull(logins.revokedAt)));
		this.#revoked({ type: "logins", userId, only: loginId });
	}

	/** 注销这个用户所有的登录（`except` 除外）。 */
	async logoutAll(userId: string, except?: string): Promise<void> {
		await this.#revokeLogins(userId, except);
		this.#revoked({ type: "logins", userId, ...(except === undefined ? {} : { except }) });
	}

	async #revokeLogins(userId: string, except?: string): Promise<void> {
		await this.#db
			.update(logins)
			.set({ revokedAt: this.#clock.now() })
			.where(
				and(
					eq(logins.userId, userId),
					isNull(logins.revokedAt),
					except === undefined ? undefined : ne(logins.id, except),
				),
			);
	}

	// ---- 密码 ----

	/**
	 * 改自己的密码（要旧密码）：旧密码不对是 `wrong_password`（也算失败，按用户限速：偷到 Cookie 的人不能借这个接口猜旧密码）。
	 * 改完之后别处的其他登录都注销，当前这个保留。
	 */
	async changePassword(
		userId: string,
		currentLoginId: string,
		oldPassword: string,
		newPassword: string,
		address: string,
	): Promise<
		| { ok: true }
		| { ok: false; reason: "wrong_password" }
		| { ok: false; reason: "throttled"; retryAfterMs: number }
	> {
		const key = `password:${userId}`;
		const wait = this.#throttle.retryAfterMs(key, address);
		if (wait > 0) return { ok: false, reason: "throttled", retryAfterMs: wait };
		const [row] = await this.#db.select().from(users).where(eq(users.id, userId));
		const stored = row?.passwordHash ?? undefined;
		const correct = await this.#passwordMatches(oldPassword, stored);
		if (!correct) {
			this.#throttle.failure(key, address);
			return { ok: false, reason: "wrong_password" };
		}
		this.#throttle.success(key, address);
		await this.#db
			.update(users)
			.set({ passwordHash: await hashPassword(newPassword, this.#scrypt) })
			.where(eq(users.id, userId));
		await this.logoutAll(userId, currentLoginId);
		return { ok: true };
	}

	// ---- 平台管理员管理账号 ----

	async listUsers(): Promise<UserRecord[]> {
		const rows = await this.#db
			.select()
			.from(users)
			.orderBy(asc(users.createdAt), asc(users.loginName));
		return rows.map(toRecord);
	}

	async findByLoginName(loginName: string): Promise<UserRecord | undefined> {
		const [row] = await this.#db
			.select()
			.from(users)
			.where(eq(users.loginName, loginName.trim().toLowerCase()));
		return row && toRecord(row);
	}

	async findUser(id: string): Promise<UserRecord | undefined> {
		const [row] = await this.#db.select().from(users).where(eq(users.id, id));
		return row && toRecord(row);
	}

	/** 建用户；登录名重复时抛 {@link LoginNameTaken}。登录名的写法由契约校验，库里还有约束兜底。 */
	async createUser(input: {
		loginName: string;
		displayName: string;
		password: string;
		isPlatformAdmin: boolean;
	}): Promise<UserRecord> {
		const passwordHash = await hashPassword(input.password, this.#scrypt);
		try {
			const [row] = await this.#db
				.insert(users)
				.values({
					id: randomUUID(),
					loginName: input.loginName,
					displayName: input.displayName,
					passwordHash,
					isPlatformAdmin: input.isPlatformAdmin,
					createdAt: this.#clock.now(),
				})
				.returning();
			if (row === undefined) throw new Error("建用户没有返回行");
			return toRecord(row);
		} catch (error) {
			if (isUniqueViolation(error)) throw new LoginNameTaken(input.loginName);
			throw error;
		}
	}

	/**
	 * 停用：他的全部登录和令牌立即失效（访问检查每次看用户有没有停用），打开的事件流关掉。
	 * 停用是可撤回的暂停，不是作废：不吊销他名下的登录、个人令牌和开发 Agent 的凭据，启用之后它们都恢复可用
	 * （要永久作废就吊销凭据本身）。已经停用的不改停用的时间。
	 */
	async disable(id: string): Promise<UserRecord | undefined> {
		const [row] = await this.#db
			.update(users)
			.set({ disabledAt: sql`coalesce(${users.disabledAt}, ${this.#clock.now()})` })
			.where(eq(users.id, id))
			.returning();
		if (row === undefined) return undefined;
		this.#revoked({ type: "user", userId: id });
		return toRecord(row);
	}

	async enable(id: string): Promise<UserRecord | undefined> {
		const [row] = await this.#db
			.update(users)
			.set({ disabledAt: null })
			.where(eq(users.id, id))
			.returning();
		return row && toRecord(row);
	}

	/** 重置密码：平台管理员给出新密码；他的全部登录注销。用户不存在时返回 false。 */
	async resetPassword(id: string, password: string): Promise<boolean> {
		const [row] = await this.#db
			.update(users)
			.set({ passwordHash: await hashPassword(password, this.#scrypt) })
			.where(eq(users.id, id))
			.returning({ id: users.id });
		if (row === undefined) return false;
		await this.logoutAll(id);
		return true;
	}
}
