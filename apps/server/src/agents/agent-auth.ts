// Agent 连接时的身份：Hello.token 是什么、能不能连上（ADR 0029「迁移与过渡」、ADR 0014，规格 #492）。
//
// - **Agent 凭据**（`sfly_agt_` 前缀，按台签发）：项目和名字从凭据得出，`Hello.name` 和它不一致就拒绝；吊销的拒绝。
//   开发 Agent 的凭据（记在一个用户名下）还要所属用户没有被停用：停用期间拒绝连接、已连着的断开（`control-plane.ts` 订阅用户
//   停用的广播），启用之后同一个凭据照常——停用是可撤回的暂停，不吊销凭据；停用的用户自己吊销不了（访问检查 401），项目管理员可以。
// - **共享令牌**（`SFLY_AGENT_TOKEN`，默认项目的旧式凭据，控制面启动时登记）：照旧可以连，界面上标出「用共享令牌连接」。
// - **没有凭据**：控制面没有配置共享令牌时，只接受默认项目里已经登记过的名字（过渡版本，下一个版本起拒绝）；配了共享令牌的部署
//   不带令牌照旧被拒绝。
// - **名字有没被吊销的 Agent 凭据，就只认凭据**：共享令牌和没有凭据的连接不能再用这个名字（真的那台离线时，冒用它的名字就拿得到
//   它的任务、入参和任务凭据）；这个名字的凭据全部吊销之后才又接受旧方式（吊销要凭据，是管理员明确的选择）。
// - **三种情况同一句话**：连接的一方对这个名字所在的项目没有有效凭据时，「还没有登记」「登记在别的项目」「这个名字有 Agent 凭据」
//   的回应是同一个、同一句话（{@link notRegisteredHere}），不能用 Hello 的回应探别的项目里有没有这个名字、有没有凭据；
//   **先比项目、后看停用**（别的项目里被停用的，和不存在一样）。
// 登记工作台之后（#549 接上 `requireAgentCredential`）只接受 Agent 凭据：共享令牌和没有凭据的连接都拒绝；登记之前先要没有还没换成
// Agent 凭据的 Agent（{@link agentsNotOnCredentials}）。
// 停用的 Agent 不论带不带凭据都不能连接。「以旧方式连接」（共享令牌和没有凭据）的连接不能顶掉带 Agent 凭据的同名连接，
// 这一条在 `AgentHub.attach`。
import { TOKEN_PREFIXES } from "@sfly/schema";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
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

/**
 * 这个名字不能这样连接，说法不透露原因：还没有登记、登记在别的项目、这个名字有 Agent 凭据而来的是旧方式，都是这一句
 * （连接的一方对这个名字所在的项目没有有效凭据）。#610 对别的项目的 Agent 的口径一样：和没有登记过一样。
 */
export const notRegisteredHere = (name: string): string =>
	`Agent「${name}」不能连接：它还没有登记，或者这次带的凭据不能登记它——让项目管理员在这个项目里为这台 Agent 签发 Agent 凭据，并用它连接`;

/**
 * 还没换成 Agent 凭据的 Agent（没有停用的，最近一次连接用的不是 Agent 凭据，或者记下之前连接的）：登记工作台之前必须是空的
 * （ADR 0029「迁移与过渡」，登记那一步在 #549，有没换的就拒绝并列出它们）。只签发过、没用它连上过的不算换了；停用的不算。
 */
export async function agentsNotOnCredentials(db: Db): Promise<string[]> {
	const rows = await db
		.select({ name: agents.name })
		.from(agents)
		.where(
			and(
				isNull(agents.disabledAt),
				or(isNull(agents.lastAuthKind), ne(agents.lastAuthKind, "agent")),
			),
		)
		.orderBy(asc(agents.name));
	return rows.map((row) => row.name);
}

const CREDENTIAL_REQUIRED =
	"控制面已经登记了工作台，只接受 Agent 凭据：共享令牌和没有凭据的连接都不再接受，让项目管理员为这台 Agent 签发 Agent 凭据";

export class AgentAuthenticator {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/**
			 * 登记工作台之后为真（#549 接上，现在没有登记，不传就是假）：只接受 Agent 凭据，共享令牌和没有凭据的连接都拒绝
			 * （共享令牌不发给工作台，但工作台在网络上够得着控制面，别处泄露的共享令牌就能冒充一台还没换凭据的 Agent）。
			 */
			requireAgentCredential?: () => boolean | Promise<boolean>;
		},
	) {}

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

		if (auth.kind !== "agent" && (await this.deps.requireAgentCredential?.())) {
			return refuse("unauthenticated", CREDENTIAL_REQUIRED);
		}

		const refusal = await this.#standing(auth, name, project);
		if (refusal !== undefined) return { ok: false, ...refusal };
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
	async recheck(auth: AgentAuth, name: string, project: ProjectId): Promise<Refusal | undefined> {
		const { db } = this.deps;
		if (auth.kind !== "agent" && (await this.deps.requireAgentCredential?.())) {
			return { code: "unauthenticated", message: CREDENTIAL_REQUIRED };
		}
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
		return this.#standing(auth, name, project);
	}

	/**
	 * 这个名字对这次连接的资格（认身份和登记前再确认共用）。**先比项目，后看停用**：
	 * 1. 名字已经登记在别的项目里：和没有登记过一样（{@link notRegisteredHere}）；
	 * 2. 以旧方式连接（共享令牌、没有凭据），而这个名字有没被吊销的 Agent 凭据：只认凭据，同一句话；
	 * 3. 登记在这个项目里、被停用：已被停用；
	 * 4. 没有凭据的连接，名字还没有登记：同一句话（过渡版本只接受已登记过的名字）。
	 * 通过返回 undefined。
	 */
	async #standing(auth: AgentAuth, name: string, project: ProjectId): Promise<Refusal | undefined> {
		const { db } = this.deps;
		const [existing] = await db
			.select({ projectId: agents.projectId, disabledAt: agents.disabledAt })
			.from(agents)
			.where(eq(agents.name, name));
		if (existing && existing.projectId !== project) {
			// 名字全局唯一：别的项目已经登记了这个名字，连接的一方对它没有有效凭据。
			return { code: "unauthenticated", message: notRegisteredHere(name) };
		}
		if (auth.kind !== "agent") {
			const [credential] = await db
				.select({ id: agentCredentials.id })
				.from(agentCredentials)
				.where(
					and(
						eq(agentCredentials.kind, "agent"),
						eq(agentCredentials.agentName, name),
						isNull(agentCredentials.revokedAt),
					),
				)
				.limit(1);
			if (credential !== undefined) {
				return { code: "unauthenticated", message: notRegisteredHere(name) };
			}
		}
		if (existing?.disabledAt) return { code: "permission_denied", message: agentDisabled(name) };
		if (auth.kind === "none" && existing === undefined) {
			return { code: "unauthenticated", message: notRegisteredHere(name) };
		}
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
