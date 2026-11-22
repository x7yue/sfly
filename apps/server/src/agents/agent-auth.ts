// Agent 连接时的身份：Hello.token 是什么、能不能连上（ADR 0029「迁移与过渡」、ADR 0014，规格 #492）。
//
// - **Agent 凭据**（`sfly_agt_` 前缀，按台签发）：项目和名字从凭据得出，`Hello.name` 和它不一致就拒绝；吊销的拒绝。
// - **共享令牌**（`SFLY_AGENT_TOKEN`，默认项目的旧式凭据，控制面启动时登记）：照旧可以连，界面上标出「用共享令牌连接」。
// - **没有凭据**：控制面没有配置共享令牌时，只接受默认项目里已经登记过的名字（过渡版本，下一个版本起拒绝）；配了共享令牌的部署
//   不带令牌照旧被拒绝。
// 停用的 Agent 不论带不带凭据都不能连接。「以旧方式连接」（共享令牌和没有凭据）的连接不能顶掉带 Agent 凭据的同名连接，
// 这一条在 `AgentHub.attach`。
import { TOKEN_PREFIXES } from "@sfly/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hashCredential } from "../auth/credential-hash.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agentCredentials, agents } from "../db/schema.js";
import { DEFAULT_PROJECT, type ProjectId } from "../projects/project-id.js";

/** 一条连接是怎么认的身份（记在连接上，也写进 `agents.last_auth_kind`）。 */
export type AgentAuth =
	| { kind: "agent"; credentialId: string }
	| { kind: "shared" }
	| { kind: "none" };

export type AuthOutcome =
	| { ok: true; auth: AgentAuth; project: ProjectId }
	| { ok: false; code: "unauthenticated" | "permission_denied"; message: string };

const refuse = (code: "unauthenticated" | "permission_denied", message: string): AuthOutcome => ({
	ok: false,
	code,
	message,
});

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
				if (credential.revokedAt !== null) {
					return refuse("unauthenticated", "invalid agent token: Agent 凭据已被吊销");
				}
				if (credential.kind === "agent") {
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
			return refuse("permission_denied", `Agent「${name}」已被停用：让项目管理员恢复它`);
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
}
