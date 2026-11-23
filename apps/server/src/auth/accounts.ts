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
import { PasswordGate, PasswordGateBusy } from "./password-gate.js";
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
	/**
	 * 密码哈希和验证的并发闸（./password-gate.ts）：所有 scrypt 都从这里过，同时算的有上限，队列满了抛 {@link PasswordGateBusy}。
	 * 默认自己建一个。
	 */
	passwordGate?: PasswordGate;
	/** 验证密码的函数，默认 {@link verifyPassword}；测试里换成数着次数的，确认被限速的请求没有去验证。 */
	verify?: (password: string, stored: string) => Promise<boolean>;
	/** 算「假哈希」的函数（登录名不存在时拿它验证一次，对齐耗时），默认按 `scrypt` 参数算；测试里换成会失败的。 */
	dummyHash?: (password: string) => Promise<string>;
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
	readonly #gate: PasswordGate;
	readonly #verifyFn: (password: string, stored: string) => Promise<boolean>;
	readonly #listeners = new Set<(revocation: Revocation) => void>();
	readonly #dummyFn: (password: string) => Promise<string>;
	#dummy: Promise<string> | undefined;

	constructor(options: AccountServiceOptions) {
		this.#db = options.db;
		this.#clock = options.clock;
		this.#scrypt = options.scrypt ?? DEFAULT_SCRYPT;
		this.#idleMs = options.loginIdleMs ?? DEFAULT_LOGIN_IDLE_MS;
		this.#throttle = options.throttle ?? new LoginThrottle(options.clock);
		this.#setupCode = options.setupCode;
		this.#gate = options.passwordGate ?? new PasswordGate();
		this.#verifyFn = options.verify ?? verifyPassword;
		this.#dummyFn = options.dummyHash ?? ((password) => hashPassword(password, this.#scrypt));
	}

	/**
	 * 提前把「假哈希」算好（控制面启动时调用，不等第一个不存在的登录名）：不然第一次碰到不存在的登录名要多算一次哈希，
	 * 比存在的用户多花一倍时间，只有那一次。算失败了不缓存，下一次用到时重新算。
	 */
	async warmUp(): Promise<void> {
		await this.#dummyHash();
	}

	/** 算一个密码的哈希：过并发闸，队列满了抛 {@link PasswordGateBusy}，不去算。 */
	#hash(password: string): Promise<string> {
		return this.#gate.run(() => hashPassword(password, this.#scrypt));
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
		// 先占位再验证（./login-throttle.ts 的 acquire）：码不对，占的位就是这次失败。
		const slot = this.#throttle.acquire("setup", address);
		if (!slot.ok) return { ok: false, reason: "throttled", retryAfterMs: slot.retryAfterMs };
		if (!this.#setupCode?.verify(input.code)) {
			// 并发的两次初始化：这个请求问「还要不要初始化」时还没有用户，验证时赢的那个请求已经建好用户、作废了码。码其实是对的，
			// 回「码不对」（403）不合理，还白白算一次猜错：再问一次，已经有用户了就是「已经初始化」（409），把占的位还回去。
			if (!(await this.setupRequired())) {
				this.#throttle.cancel("setup", address);
				return { ok: false, reason: "setup_done" };
			}
			return { ok: false, reason: "bad_code" };
		}
		this.#throttle.confirm("setup", address);
		const passwordHash = await this.#hash(input.password);
		const created = await this.#createFirstAdmin({ ...input, passwordHash });
		if (created === undefined) return { ok: false, reason: "setup_done" };
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
		const passwordHash = await this.#hash(input.password);
		return (await this.#createFirstAdmin({ ...input, passwordHash })) !== undefined;
	}

	// ---- 登录与登出 ----

	/**
	 * 一个不存在的用户也要花同样的时间验证一次密码，响应时间不泄露「登录名有没有这个人」：拿一个假哈希验证。
	 * 假哈希只算一次、缓存起来，**不过并发闸**：它不是某个请求的验证，闸正好满的时候第一次算它被拒绝的话，
	 * 被拒绝的结果会被一直缓存，之后不存在的登录名永远是 503，存在的用户错密码却是 401，能直接分辨登录名有没有这个人
	 * （PR #555 的差异复审）。同时只会有这一个在算，不会放大闸要挡住的负载；算失败了不缓存，下一次重新算。
	 */
	#dummyHash(): Promise<string> {
		this.#dummy ??= this.#dummyFn(randomBytes(16).toString("hex")).catch((error: unknown) => {
			this.#dummy = undefined;
			throw error;
		});
		return this.#dummy;
	}

	/** 密码对不对；没有存储的密码（用户不存在、只靠外部身份登录）也要花同样的时间验证一次，响应时间不泄露这一点。 */
	async #passwordMatches(
		password: string,
		stored: string | undefined,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (stored !== undefined) return this.#gate.run(() => this.#verifyFn(password, stored), signal);
		const dummy = await this.#dummyHash();
		await this.#gate.run(() => this.#verifyFn(password, dummy), signal);
		return false;
	}

	/**
	 * 登录。`signal` 是请求的中止信号（客户端断开）：排队等着验证时断开，就不去验证，抛 `PasswordGateAborted`，
	 * 占的限速名额还回去（不是这个人的失败）；已经在算的不打断。
	 */
	async login(
		loginName: string,
		password: string,
		address: string,
		signal?: AbortSignal,
	): Promise<
		| { ok: true; login: LoggedIn }
		| { ok: false; reason: "invalid" }
		| { ok: false; reason: "throttled"; retryAfterMs: number }
	> {
		const name = loginName.trim().toLowerCase();
		// 先占位再验证：验证一次要算几百毫秒，并发的请求都在「还没有失败」的时候通过检查就等于没有限速。
		const slot = this.#throttle.acquire(name, address);
		if (!slot.ok) return { ok: false, reason: "throttled", retryAfterMs: slot.retryAfterMs };
		let row: typeof users.$inferSelect | undefined;
		let stored: string | undefined;
		let correct: boolean;
		try {
			[row] = await this.#db.select().from(users).where(eq(users.loginName, name));
			stored = row?.passwordHash ?? undefined;
			correct = await this.#passwordMatches(password, stored, signal);
		} catch (error) {
			// 没有验证成（算不过来被拒绝、读库出错）：不是这个人的失败，把占的位还回去。
			this.#throttle.cancel(name, address);
			throw error;
		}
		// 停用的账号和密码不对一样：不告诉对方账号是否存在、是否停用。占的位就是这次失败。
		if (row === undefined || !correct || row.disabledAt !== null) {
			return { ok: false, reason: "invalid" };
		}
		this.#throttle.confirm(name, address);
		// 参数调高之后，旧哈希在这次登录成功时按新参数重新存（并发闸满了就下次再说）。
		if (stored !== undefined && needsRehash(stored, this.#scrypt)) {
			try {
				await this.#db
					.update(users)
					.set({ passwordHash: await this.#hash(password) })
					.where(eq(users.id, row.id));
			} catch (error) {
				if (!(error instanceof PasswordGateBusy)) throw error;
			}
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
	 * 验证旧密码排队时客户端断开（`signal`）同登录：不验证，抛 `PasswordGateAborted`，占位还回去。
	 * 改完之后别处的其他登录都注销，当前这个保留。
	 */
	async changePassword(
		userId: string,
		currentLoginId: string,
		oldPassword: string,
		newPassword: string,
		address: string,
		signal?: AbortSignal,
	): Promise<
		| { ok: true }
		| { ok: false; reason: "wrong_password" }
		| { ok: false; reason: "throttled"; retryAfterMs: number }
	> {
		const key = `password:${userId}`;
		const slot = this.#throttle.acquire(key, address);
		if (!slot.ok) return { ok: false, reason: "throttled", retryAfterMs: slot.retryAfterMs };
		let correct: boolean;
		try {
			const [row] = await this.#db.select().from(users).where(eq(users.id, userId));
			correct = await this.#passwordMatches(oldPassword, row?.passwordHash ?? undefined, signal);
		} catch (error) {
			this.#throttle.cancel(key, address);
			throw error;
		}
		// 旧密码不对：占的位就是这次失败。
		if (!correct) return { ok: false, reason: "wrong_password" };
		this.#throttle.confirm(key, address);
		await this.#db
			.update(users)
			.set({ passwordHash: await this.#hash(newPassword) })
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
		const passwordHash = await this.#hash(input.password);
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
			.set({ passwordHash: await this.#hash(password) })
			.where(eq(users.id, id))
			.returning({ id: users.id });
		if (row === undefined) return false;
		await this.logoutAll(id);
		return true;
	}
}
