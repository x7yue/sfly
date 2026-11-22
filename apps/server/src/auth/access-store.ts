// 访问检查读的数据（凭据、用户、成员、资源所在的项目）。接口和实现分开：鉴权模块（./access-guard.ts）只认接口，
// 可以不连数据库单独测试；数据库实现在这个文件里。
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/database.js";
import {
	agentCredentials,
	apiTokens,
	logins,
	orchestrations,
	type ProjectRole,
	platformAdminActions,
	projectMembers,
	projects,
	runs,
	sessions,
	tasks,
	users,
} from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";

/** 凭据背后的用户；停用的用户的全部凭据立即无效。 */
export interface StoredUser {
	id: string;
	displayName: string;
	disabledAt: Date | null;
	isPlatformAdmin: boolean;
}

/** 库里的令牌（个人、项目、会话、任务凭据）。 */
export interface StoredToken {
	id: string;
	kind: "personal" | "project" | "session" | "task";
	name: string;
	/** 令牌的所属用户（个人令牌）或发起人（会话令牌）；项目令牌和任务凭据没有。 */
	user: StoredUser | null;
	/** 项目令牌所属的项目；个人令牌限定的项目（没有限定为 null）；会话令牌、任务凭据限定的项目。 */
	projectId: ProjectId | null;
	scopes: readonly string[];
	expiresAt: Date | null;
	revokedAt: Date | null;
}

/** 库里的登录（控制台的 Cookie）。 */
export interface StoredLogin {
	id: string;
	user: StoredUser;
	lastUsedAt: Date;
	idleExpiresAt: Date;
	revokedAt: Date | null;
}

/** 库里的 Agent 凭据：按台签发的（项目 + 名字），或旧式的共享令牌（默认项目，不限名字）。 */
export interface StoredAgentCredential {
	kind: "agent" | "shared";
	projectId: ProjectId;
	agentName: string | null;
	/** 开发 Agent 的凭据记在编辑者名下：用户被停用时它随之失效；按台签发的和共享令牌没有用户。 */
	user: StoredUser | null;
	revokedAt: Date | null;
}

/** 平台管理员在不是成员的项目里做的一次写操作（`platform_admin_actions` 的一行）。 */
export interface AdminWrite {
	projectId: ProjectId;
	userId: string;
	at: Date;
	route: string;
	resourceKind: string;
	resourceId: string | null;
	tokenName: string | null;
	/** 他这时在这个项目里的角色；不是成员为 null。 */
	memberRole: ProjectRole | null;
}

export interface AccessStore {
	/** 按哈希找令牌（`hashCredential`）。 */
	tokenByHash(hash: string): Promise<StoredToken | undefined>;
	/** 按 Cookie 的哈希找登录。 */
	loginByCookieHash(hash: string): Promise<StoredLogin | undefined>;
	/** 用了一次登录：记下最后使用的时间，并把空闲期限顺延。 */
	touchLogin(id: string, lastUsedAt: Date, idleExpiresAt: Date): Promise<void>;
	agentCredentialByHash(hash: string): Promise<StoredAgentCredential | undefined>;
	/**
	 * 这些登录和令牌里现在还有效的（没吊销、没过期、所属用户没停用）：打开着的事件流定期按它重新检查凭据，
	 * 命令行重置密码、直接改库、空闲期限到了这些进程内收不到通知的失效，也能把打开的流关掉。每种一次查询，查一批。
	 */
	liveCredentials(
		ids: { loginIds: readonly string[]; tokenIds: readonly string[] },
		now: Date,
	): Promise<{ loginIds: Set<string>; tokenIds: Set<string> }>;
	/** 用户在项目里的角色；不是成员时为 undefined。 */
	role(project: ProjectId, userId: string): Promise<ProjectRole | undefined>;
	projectExists(project: ProjectId): Promise<boolean>;
	/** 场景、运行、任务所在的项目；不存在时为 undefined（任务经它所属的运行）。 */
	projectOfScenario(id: string): Promise<ProjectId | undefined>;
	projectOfRun(id: string): Promise<ProjectId | undefined>;
	projectOfTask(id: string): Promise<ProjectId | undefined>;
	/** 会话所在的项目；不存在时为 undefined。 */
	projectOfSession(id: string): Promise<ProjectId | undefined>;
	/** 任务所在的项目，以及派给了哪台 Agent（排队中、内置节点的任务没有）。 */
	taskAssignment(
		id: string,
	): Promise<{ projectId: ProjectId; agentName: string | null } | undefined>;
	/** 记一次平台管理员的写，返回记录的 ID（请求结束时用它回填响应的状态码）。 */
	recordAdminWrite(write: AdminWrite): Promise<string>;
	/** 回填响应的状态码。 */
	completeAdminWrite(id: string, status: number): Promise<void>;
}

const userColumns = {
	id: users.id,
	displayName: users.displayName,
	disabledAt: users.disabledAt,
	isPlatformAdmin: users.isPlatformAdmin,
};

/** 数据库实现：每个方法一条查询。 */
export class DbAccessStore implements AccessStore {
	constructor(private readonly db: Db) {}

	async tokenByHash(hash: string): Promise<StoredToken | undefined> {
		const [row] = await this.db
			.select({
				id: apiTokens.id,
				kind: apiTokens.kind,
				name: apiTokens.name,
				projectId: apiTokens.projectId,
				scopes: apiTokens.scopes,
				expiresAt: apiTokens.expiresAt,
				revokedAt: apiTokens.revokedAt,
				user: userColumns,
			})
			.from(apiTokens)
			.leftJoin(users, eq(users.id, apiTokens.userId))
			.where(eq(apiTokens.tokenHash, hash));
		return (
			row && {
				id: row.id,
				kind: row.kind,
				name: row.name,
				user: row.user,
				projectId: row.projectId,
				scopes: row.scopes,
				expiresAt: row.expiresAt,
				revokedAt: row.revokedAt,
			}
		);
	}

	async loginByCookieHash(hash: string): Promise<StoredLogin | undefined> {
		const [row] = await this.db
			.select({
				id: logins.id,
				lastUsedAt: logins.lastUsedAt,
				idleExpiresAt: logins.idleExpiresAt,
				revokedAt: logins.revokedAt,
				user: userColumns,
			})
			.from(logins)
			.innerJoin(users, eq(users.id, logins.userId))
			.where(eq(logins.cookieHash, hash));
		return row;
	}

	async touchLogin(id: string, lastUsedAt: Date, idleExpiresAt: Date): Promise<void> {
		await this.db.update(logins).set({ lastUsedAt, idleExpiresAt }).where(eq(logins.id, id));
	}

	async agentCredentialByHash(hash: string): Promise<StoredAgentCredential | undefined> {
		const [row] = await this.db
			.select({
				kind: agentCredentials.kind,
				projectId: agentCredentials.projectId,
				agentName: agentCredentials.agentName,
				revokedAt: agentCredentials.revokedAt,
				user: userColumns,
			})
			.from(agentCredentials)
			.leftJoin(users, eq(users.id, agentCredentials.userId))
			.where(eq(agentCredentials.tokenHash, hash));
		return row;
	}

	async liveCredentials(
		ids: { loginIds: readonly string[]; tokenIds: readonly string[] },
		now: Date,
	): Promise<{ loginIds: Set<string>; tokenIds: Set<string> }> {
		const [liveLogins, liveTokens] = await Promise.all([
			ids.loginIds.length === 0
				? []
				: this.db
						.select({ id: logins.id })
						.from(logins)
						.innerJoin(users, eq(users.id, logins.userId))
						.where(
							and(
								inArray(logins.id, [...ids.loginIds]),
								isNull(logins.revokedAt),
								gt(logins.idleExpiresAt, now),
								isNull(users.disabledAt),
							),
						),
			ids.tokenIds.length === 0
				? []
				: this.db
						.select({ id: apiTokens.id })
						.from(apiTokens)
						.leftJoin(users, eq(users.id, apiTokens.userId))
						.where(
							and(
								inArray(apiTokens.id, [...ids.tokenIds]),
								isNull(apiTokens.revokedAt),
								or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
								// 项目令牌没有用户（左连接出来是空）；有用户的，用户没停用。
								isNull(users.disabledAt),
							),
						),
		]);
		return {
			loginIds: new Set(liveLogins.map((row) => row.id)),
			tokenIds: new Set(liveTokens.map((row) => row.id)),
		};
	}

	async role(project: ProjectId, userId: string): Promise<ProjectRole | undefined> {
		const [row] = await this.db
			.select({ role: projectMembers.role })
			.from(projectMembers)
			.where(and(eq(projectMembers.projectId, project), eq(projectMembers.userId, userId)));
		return row?.role;
	}

	async projectExists(project: ProjectId): Promise<boolean> {
		const rows = await this.db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, project));
		return rows.length > 0;
	}

	// 下面按 ID 查的几个方法自己也先判断格式（调用方已经判断过一次）：PostgreSQL 对不是 UUID 的字符串报错，
	// 一处漏判就是 500，所以不指望每个调用方都记得。
	async projectOfScenario(id: string): Promise<ProjectId | undefined> {
		if (!isUuid(id)) return undefined;
		const [row] = await this.db
			.select({ projectId: orchestrations.projectId })
			.from(orchestrations)
			.where(eq(orchestrations.id, id));
		return row?.projectId;
	}

	async projectOfRun(id: string): Promise<ProjectId | undefined> {
		if (!isUuid(id)) return undefined;
		const [row] = await this.db
			.select({ projectId: runs.projectId })
			.from(runs)
			.where(eq(runs.id, id));
		return row?.projectId;
	}

	async projectOfTask(id: string): Promise<ProjectId | undefined> {
		return (await this.taskAssignment(id))?.projectId;
	}

	async projectOfSession(id: string): Promise<ProjectId | undefined> {
		if (!isUuid(id)) return undefined;
		const [row] = await this.db
			.select({ projectId: sessions.projectId })
			.from(sessions)
			.where(eq(sessions.id, id));
		return row?.projectId;
	}

	async taskAssignment(
		id: string,
	): Promise<{ projectId: ProjectId; agentName: string | null } | undefined> {
		if (!isUuid(id)) return undefined;
		const [row] = await this.db
			.select({ projectId: runs.projectId, agentName: tasks.agentName })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(eq(tasks.id, id));
		return row;
	}

	async recordAdminWrite(write: AdminWrite): Promise<string> {
		const id = randomUUID();
		await this.db.insert(platformAdminActions).values({ id, ...write });
		return id;
	}

	async completeAdminWrite(id: string, status: number): Promise<void> {
		await this.db
			.update(platformAdminActions)
			.set({ status })
			.where(eq(platformAdminActions.id, id));
	}
}
