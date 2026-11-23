// Agent 连接时的身份：Hello.token 是什么、能不能连上（ADR 0029「迁移与过渡」、ADR 0014，规格 #492）。
//
// - **Agent 凭据**（`sfly_agt_` 前缀，按台签发）：项目和名字从凭据得出，`Hello.name` 和它不一致就拒绝；吊销的拒绝。
// - **共享令牌**（`SFLY_AGENT_TOKEN`，默认项目的旧式凭据，控制面启动时登记）：照旧可以连，界面上标出「用共享令牌连接」。
//   开发 Agent 的凭据（记在一个用户名下）还要所属用户没有被停用：停用期间拒绝连接、已连着的断开（`control-plane.ts` 订阅用户
//   停用的广播），启用之后同一个凭据照常——停用是可撤回的暂停，不吊销凭据；停用的用户自己吊销不了（访问检查 401），项目管理员可以。
// - **没有凭据**：控制面没有配置共享令牌时，只接受默认项目里已经登记过的名字（过渡版本，下一个版本起拒绝）；配了共享令牌的部署
//   不带令牌照旧被拒绝。
// 停用的 Agent 不论带不带凭据都不能连接。「以旧方式连接」（共享令牌和没有凭据）的连接不能顶掉带 Agent 凭据的同名连接，
// 这一条在 `AgentHub.attach`。
import { TOKEN_PREFIXES } from "@sfly/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hashCredential } from "../auth/credential-hash.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agentCredentials, agents, users } from "../db/schema.js";
import { DEFAULT_PROJECT, type ProjectId } from "../projects/project-id.js";

/** 一条连接是怎么认的身份（记在连接上，也写进 `agents.last_auth_kind`）。 */
export type AgentAuth =
	| { kind: "agent"; credentialId: string }
	| { kind: "shared" }
	| { kind: "none" };

export interface Refusal {
	code: "unauthenticated" | "permission_denied";
	message: string;
}

export type AuthOutcome =
	| { ok: true; auth: AgentAuth; project: ProjectId }
	| ({ ok: false } & Refusal);

const refuse = (code: Refusal["code"], message: string): AuthOutcome & { ok: false } => ({
	ok: false,
	code,
	message,
});

const REVOKED = "invalid agent token: Agent 凭据已被吊销";
const OWNER_DISABLED =
	"invalid agent token: 这个开发 Agent 所属的用户已被停用，恢复用户之后才能连接";
const agentDisabled = (name: string) => `Agent「${name}」已被停用：让项目管理员恢复它`;

export class AgentAuthenticator {
	constructor(private readonly deps: { db: Db; clock: Clock }) {}

	/** 认 Hello 里的凭据；通过时记下凭据的最后使用时间。 */
	async authenticate(token: string | undefined, name: string): Promise<AuthOutcome> {
		const { db } = this.deps;
		const presented = token ?? "";
		let auth: AgentAuth = { kind: "none" };
		let project: ProjectId = DEFAULT_PROJECT;
		let used: string | undefined;

		const [shared] = await db
			.select({ id: agentCredentials.id })
			.from(agentCredentials)
			.where(and(eq(agentCredentials.kind, "shared"), isNull(agentCredentials.revokedAt)))
			.limit(1);
		const sharedConfigured = shared !== undefined;

		if (presented !== "") {
			const [credential] = await db
				.select()
				.from(agentCredentials)
				.where(eq(agentCredentials.tokenHash, hashCredential(presented)));
			if (credential) {
				if (credential.revokedAt !== null) return refuse("unauthenticated", REVOKED);
				if (credential.kind === "agent") {
					if (credential.userId !== null && (await this.#ownerDisabled(credential.userId))) {
						return refuse("unauthenticated", OWNER_DISABLED);
					}
					if (credential.agentName !== name) {
						return refuse(
							"permission_denied",
							`这个 Agent 凭据属于「${credential.agentName}」，Hello 报的名字是「${name}」：一个凭据只能用来连它自己的那一台`,
						);
					}
					auth = { kind: "agent", credentialId: credential.id };
					project = credential.projectId;
				} else {
					auth = { kind: "shared" };
				}
				used = credential.id;
			} else if (presented.startsWith(TOKEN_PREFIXES.agent) || sharedConfigured) {
				return refuse("unauthenticated", "invalid agent token");
			}
			// 控制面没有配置共享令牌、带的也不是 Agent 凭据：旧版本照旧接受（当作没有凭据）。
		} else if (sharedConfigured) {
			return refuse(
				"unauthenticated",
				"invalid agent token: 控制面配置了共享令牌，需要带令牌或 Agent 凭据",
			);
		}

		const [existing] = await db
			.select({ projectId: agents.projectId, disabledAt: agents.disabledAt })
			.from(agents)
			.where(eq(agents.name, name));
		if (existing?.disabledAt) {
			return refuse("permission_denied", agentDisabled(name));
		}
		if (existing && existing.projectId !== project) {
			// 名字第一步全局唯一：别的项目已经登记了这个名字。
			return refuse("permission_denied", `Agent 名字「${name}」已经在别的项目里登记了：换一个名字`);
		}
		if (auth.kind === "none" && existing === undefined) {
			return refuse(
				"unauthenticated",
				`没有凭据的 Agent 只接受已登记过的名字（过渡版本）：「${name}」还没有登记，让项目管理员为它签发 Agent 凭据`,
			);
		}
		if (used !== undefined) {
			await db
				.update(agentCredentials)
				.set({ lastUsedAt: this.deps.clock.now() })
				.where(eq(agentCredentials.id, used));
		}
		return { ok: true, auth, project };
	}

	/**
	 * 连接登记进连接表之前、在引擎的锁里再看一遍（{@link AgentHub.attach} 的 `verify`）：认身份之后、登记之前，凭据可能被吊销、
	 * 所属用户可能被停用、这台 Agent 可能被停用；吊销和停用时断开已登记的连接也在同一把锁里（`closeByCredentials`、`setDisabled`），
	 * 所以不论谁先，不会有一条已经被取消资格的连接留在连接表里。返回 undefined 表示没有问题。
	 */
	async recheck(auth: AgentAuth, name: string): Promise<Refusal | undefined> {
		const { db } = this.deps;
		if (auth.kind === "agent") {
			const [credential] = await db
				.select({ revokedAt: agentCredentials.revokedAt, userId: agentCredentials.userId })
				.from(agentCredentials)
				.where(eq(agentCredentials.id, auth.credentialId));
			if (credential === undefined || credential.revokedAt !== null) {
				return { code: "unauthenticated", message: REVOKED };
			}
			if (credential.userId !== null && (await this.#ownerDisabled(credential.userId))) {
				return { code: "unauthenticated", message: OWNER_DISABLED };
			}
		}
		const [existing] = await db
			.select({ disabledAt: agents.disabledAt })
			.from(agents)
			.where(eq(agents.name, name));
		if (existing?.disabledAt) return { code: "permission_denied", message: agentDisabled(name) };
		return undefined;
	}

	async #ownerDisabled(userId: string): Promise<boolean> {
		const [owner] = await this.deps.db
			.select({ disabledAt: users.disabledAt })
			.from(users)
			.where(eq(users.id, userId));
		return owner?.disabledAt !== null;
	}
}
