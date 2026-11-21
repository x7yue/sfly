// 访问检查读的数据（凭据、用户、成员、资源所在的项目）。接口和实现分开：鉴权模块（./access-guard.ts）只认接口，
// 可以不连数据库单独测试；数据库实现在这个文件里。
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
	tasks,
	users,
} from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/** 凭据背后的用户；停用的用户的全部凭据立即无效。 */
export interface StoredUser {
	id: string;
	displayName: string;
	disabledAt: Date | null;
	isPlatformAdmin: boolean;
}

/** 库里的令牌（个人、项目、会话、任务凭据）。 */
export interface StoredToken {
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
	user: StoredUser;
	idleExpiresAt: Date;
	revokedAt: Date | null;
}

/** 库里的 Agent 凭据：按台签发的（项目 + 名字），或旧式的共享令牌（默认项目，不限名字）。 */
export interface StoredAgentCredential {
	kind: "agent" | "shared";
	projectId: ProjectId;
	agentName: string | null;
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
}

export interface AccessStore {
	/** 按哈希找令牌（`hashCredential`）。 */
	tokenByHash(hash: string): Promise<StoredToken | undefined>;
	/** 按 Cookie 的哈希找登录。 */
	loginByCookieHash(hash: string): Promise<StoredLogin | undefined>;
	agentCredentialByHash(hash: string): Promise<StoredAgentCredential | undefined>;
	/** 用户在项目里的角色；不是成员时为 undefined。 */
	role(project: ProjectId, userId: string): Promise<ProjectRole | undefined>;
	projectExists(project: ProjectId): Promise<boolean>;
	/** 场景、运行、任务所在的项目；不存在时为 undefined（任务经它所属的运行）。 */
	projectOfScenario(id: string): Promise<ProjectId | undefined>;
	projectOfRun(id: string): Promise<ProjectId | undefined>;
	projectOfTask(id: string): Promise<ProjectId | undefined>;
	/** 任务所在的项目，以及派给了哪台 Agent（排队中、内置节点的任务没有）。 */
	taskAssignment(
		id: string,
	): Promise<{ projectId: ProjectId; agentName: string | null } | undefined>;
	recordAdminWrite(write: AdminWrite): Promise<void>;
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
				idleExpiresAt: logins.idleExpiresAt,
				revokedAt: logins.revokedAt,
				user: userColumns,
			})
			.from(logins)
			.innerJoin(users, eq(users.id, logins.userId))
			.where(eq(logins.cookieHash, hash));
		return row && { idleExpiresAt: row.idleExpiresAt, revokedAt: row.revokedAt, user: row.user };
	}

	async agentCredentialByHash(hash: string): Promise<StoredAgentCredential | undefined> {
		const [row] = await this.db
			.select({
				kind: agentCredentials.kind,
				projectId: agentCredentials.projectId,
				agentName: agentCredentials.agentName,
				revokedAt: agentCredentials.revokedAt,
			})
			.from(agentCredentials)
			.where(eq(agentCredentials.tokenHash, hash));
		return row;
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

	async projectOfScenario(id: string): Promise<ProjectId | undefined> {
		const [row] = await this.db
			.select({ projectId: orchestrations.projectId })
			.from(orchestrations)
			.where(eq(orchestrations.id, id));
		return row?.projectId;
	}

	async projectOfRun(id: string): Promise<ProjectId | undefined> {
		const [row] = await this.db
			.select({ projectId: runs.projectId })
			.from(runs)
			.where(eq(runs.id, id));
		return row?.projectId;
	}

	async projectOfTask(id: string): Promise<ProjectId | undefined> {
		return (await this.taskAssignment(id))?.projectId;
	}

	async taskAssignment(
		id: string,
	): Promise<{ projectId: ProjectId; agentName: string | null } | undefined> {
		const [row] = await this.db
			.select({ projectId: runs.projectId, agentName: tasks.agentName })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(eq(tasks.id, id));
		return row;
	}

	async recordAdminWrite(write: AdminWrite): Promise<void> {
		await this.db.insert(platformAdminActions).values({ id: randomUUID(), ...write });
	}
}
