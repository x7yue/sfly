// Agent 凭据的签发、吊销和「我的开发 Agent」（ADR 0029「凭据」，规格 #492）。
// 凭据是 `sfly_agt_` 前缀加一串随机字符，库里只存 SHA-256 哈希（`agent_credentials.token_hash`）和展示用的前缀，原值只在签发的
// 那一次响应里出现。一台 Agent 可以同时有几个有效的凭据（轮换：先签发新的、换上之后吊销旧的）。
import { randomBytes, randomUUID } from "node:crypto";
import {
	type AgentCredentialView,
	DEV_AGENT_HOST_MAX,
	DEV_AGENT_HOST_PATTERN,
	DEV_AGENT_NAME_MAX,
	TOKEN_PREFIXES,
} from "@sfly/schema";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { hashCredential } from "../auth/credential-hash.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agentCredentials, agents, users } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/** 随机字符的字节数：和令牌一样，48 个十六进制字符。 */
const SECRET_BYTES = 24;
/** 展示用的前缀长度：`sfly_agt_` 加原值开头的几个字符。 */
const PREFIX_LENGTH = 13;

const newSecret = (): string =>
	`${TOKEN_PREFIXES.agent}${randomBytes(SECRET_BYTES).toString("hex")}`;

type CredentialRow = typeof agentCredentials.$inferSelect;

const view = (row: CredentialRow, user: string | null): AgentCredentialView => ({
	id: row.id,
	prefix: row.prefix ?? "",
	created_at: row.createdAt.toISOString(),
	last_used_at: row.lastUsedAt?.toISOString() ?? null,
	revoked_at: row.revokedAt?.toISOString() ?? null,
	user,
});

/** 开发 Agent 的名字：`dev-<登录名>-<主机>`。登录名的字符集不含连字符，所以 `dev-` 之后到下一个连字符之前就是登录名。 */
export const devAgentName = (loginName: string, host: string): string => `dev-${loginName}-${host}`;

export type IssueDevFailure =
	| { reason: "invalid_host" }
	| { reason: "name_too_long"; name: string }
	| { reason: "exists"; name: string };

export type RevokeDevResult =
	| { kind: "revoked" | "already_revoked" }
	| { kind: "not_found" }
	| { kind: "forbidden" };

export class AgentCredentialService {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 凭据被吊销：用它连着的 Agent 连接要断开（AgentHub.closeByCredentials）。 */
			onRevoked?: (credentialIds: string[]) => Promise<void> | void;
		},
	) {}

	/** 一台 Agent 的凭据，从新到旧（含已吊销的）；不含原值。 */
	async list(project: ProjectId, agentName: string): Promise<AgentCredentialView[]> {
		const rows = await this.deps.db
			.select({ credential: agentCredentials, user: users.displayName })
			.from(agentCredentials)
			.leftJoin(users, eq(users.id, agentCredentials.userId))
			.where(
				and(
					eq(agentCredentials.projectId, project),
					eq(agentCredentials.agentName, agentName),
					eq(agentCredentials.kind, "agent"),
				),
			)
			.orderBy(desc(agentCredentials.createdAt), desc(agentCredentials.id));
		return rows.map((row) => view(row.credential, row.user));
	}

	/** 记在这个用户名下的有效凭据（开发 Agent 的）：用户被停用时，用它们连着的连接要断开。 */
	async liveIdsOfUser(userId: string): Promise<string[]> {
		const rows = await this.deps.db
			.select({ id: agentCredentials.id })
			.from(agentCredentials)
			.where(
				and(
					eq(agentCredentials.kind, "agent"),
					eq(agentCredentials.userId, userId),
					isNull(agentCredentials.revokedAt),
				),
			);
		return rows.map((row) => row.id);
	}

	/** 为「项目 + Agent 名字」签发一个凭据；`userId` 是开发 Agent 的所属用户（按台签发的没有）。 */
	async issue(
		project: ProjectId,
		agentName: string,
		options: { userId?: string; userName?: string } = {},
	): Promise<{ credential: AgentCredentialView; token: string }> {
		const token = newSecret();
		const [row] = await this.deps.db
			.insert(agentCredentials)
			.values({
				id: randomUUID(),
				kind: "agent",
				projectId: project,
				agentName,
				prefix: token.slice(0, PREFIX_LENGTH),
				tokenHash: hashCredential(token),
				userId: options.userId ?? null,
				createdAt: this.deps.clock.now(),
			})
			.returning();
		return { credential: view(row as CredentialRow, options.userName ?? null), token };
	}

	/** 吊销一台 Agent 的一个凭据：不存在（或不是这台 Agent 的）是 not_found，已经吊销的再吊销不变。 */
	async revoke(
		project: ProjectId,
		agentName: string,
		id: string,
	): Promise<"revoked" | "already_revoked" | "not_found"> {
		const [row] = await this.deps.db
			.select()
			.from(agentCredentials)
			.where(
				and(
					eq(agentCredentials.id, id),
					eq(agentCredentials.projectId, project),
					eq(agentCredentials.agentName, agentName),
					eq(agentCredentials.kind, "agent"),
				),
			);
		if (!row) return "not_found";
		if (row.revokedAt !== null) {
			// 先到的吊销可能还在等着断开：重复的这次也等用它的连接断开、记为离线之后再返回。
			await this.deps.onRevoked?.([id]);
			return "already_revoked";
		}
		await this.deps.db
			.update(agentCredentials)
			.set({ revokedAt: this.deps.clock.now() })
			.where(and(eq(agentCredentials.id, id), isNull(agentCredentials.revokedAt)));
		await this.deps.onRevoked?.([id]);
		return "revoked";
	}

	/**
	 * 注册一个开发 Agent：名字由控制面生成（`dev-<登录名>-<主机>`），凭据记在这个用户名下。同一个人在同一个项目里重名
	 * （这个名字已经有有效的凭据，或者已经有别的来历的 Agent 用着这个名字）时拒绝，提示换一个主机名；
	 * 以前注册过、凭据都吊销了的同一个人可以重新注册。
	 */
	async issueDev(
		project: ProjectId,
		user: { id: string; loginName: string; displayName: string },
		host: string,
	): Promise<
		| { ok: true; name: string; credential: AgentCredentialView; token: string }
		| ({ ok: false } & IssueDevFailure)
	> {
		if (host.length > DEV_AGENT_HOST_MAX || !DEV_AGENT_HOST_PATTERN.test(host)) {
			return { ok: false, reason: "invalid_host" };
		}
		const name = devAgentName(user.loginName, host);
		if (name.length > DEV_AGENT_NAME_MAX) return { ok: false, reason: "name_too_long", name };
		const token = newSecret();
		return this.deps.db.transaction(async (tx) => {
			// 同名的并发注册串行：检查和插入之间，别的注册不能插进来。
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dev-agent:${name}`}))`);
			const [active] = await tx
				.select({ id: agentCredentials.id })
				.from(agentCredentials)
				.where(
					and(
						eq(agentCredentials.kind, "agent"),
						eq(agentCredentials.projectId, project),
						eq(agentCredentials.agentName, name),
						isNull(agentCredentials.revokedAt),
					),
				)
				.limit(1);
			if (active) return { ok: false, reason: "exists", name } as const;
			const [existing] = await tx
				.select({ name: agents.name })
				.from(agents)
				.where(eq(agents.name, name));
			if (existing) {
				// 这个名字已经有一台 Agent：只有当初是这个人注册的（他名下有过这个名字的凭据），才算重新注册。
				const [mine] = await tx
					.select({ id: agentCredentials.id })
					.from(agentCredentials)
					.where(
						and(
							eq(agentCredentials.agentName, name),
							eq(agentCredentials.projectId, project),
							eq(agentCredentials.userId, user.id),
						),
					)
					.limit(1);
				if (!mine) return { ok: false, reason: "exists", name } as const;
			}
			const [row] = await tx
				.insert(agentCredentials)
				.values({
					id: randomUUID(),
					kind: "agent",
					projectId: project,
					agentName: name,
					prefix: token.slice(0, PREFIX_LENGTH),
					tokenHash: hashCredential(token),
					userId: user.id,
					createdAt: this.deps.clock.now(),
				})
				.returning();
			return {
				ok: true,
				name,
				credential: view(row as CredentialRow, user.displayName),
				token,
			} as const;
		});
	}

	/**
	 * 吊销一台开发 Agent 的凭据（它的全部有效凭据）：要是自己的，或者调用方有「管理」范围（`canManage`）。
	 * 不是开发 Agent（没有用户的凭据）、没有这个名字：not_found；全都吊销过：already_revoked。
	 */
	async revokeDev(
		project: ProjectId,
		name: string,
		by: { userId: string; canManage: boolean },
	): Promise<RevokeDevResult> {
		const rows = await this.deps.db
			.select()
			.from(agentCredentials)
			.where(
				and(
					eq(agentCredentials.kind, "agent"),
					eq(agentCredentials.projectId, project),
					eq(agentCredentials.agentName, name),
					isNotNull(agentCredentials.userId),
				),
			);
		if (rows.length === 0) return { kind: "not_found" };
		if (!by.canManage && rows.some((row) => row.userId !== by.userId)) return { kind: "forbidden" };
		const live = rows.filter((row) => row.revokedAt === null);
		if (live.length === 0) {
			await this.deps.onRevoked?.(rows.map((row) => row.id));
			return { kind: "already_revoked" };
		}
		const ids = live.map((row) => row.id);
		await this.deps.db
			.update(agentCredentials)
			.set({ revokedAt: this.deps.clock.now() })
			.where(and(inArray(agentCredentials.id, ids), isNull(agentCredentials.revokedAt)));
		// 本次查到的全部凭据都交给断开：之前吊销了、离线还没记上的同名连接一并处理。
		await this.deps.onRevoked?.(rows.map((row) => row.id));
		return { kind: "revoked" };
	}
}
