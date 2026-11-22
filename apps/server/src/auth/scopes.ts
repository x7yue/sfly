// 范围与角色（ADR 0029「用户、项目与角色」「一处检查」）。不依赖 Fastify，鉴权模块和它的测试都从这里取。
import type { Effect, ResourceKind } from "@sfly/schema";
import type { ProjectRole } from "../db/schema.js";

/** 范围：检查只看范围，不看角色名（以后加「只能触发运行」这类角色，只是多一组范围）。 */
export const SCOPES = ["read", "run", "edit", "session_build", "publish", "manage"] as const;
export type Scope = (typeof SCOPES)[number];

/** 范围的中文名（GLOSSARY「令牌」里的词），写进拒绝的说明。 */
export const SCOPE_LABELS = {
	read: "读",
	run: "运行",
	edit: "编辑",
	session_build: "会话构建",
	publish: "发布",
	manage: "管理",
} as const satisfies Record<Scope, string>;

/** 每种角色是固定的一组范围（ADR 0029 的范围表）。 */
export const ROLE_SCOPES = {
	read_only: ["read"],
	editor: ["read", "run", "edit", "session_build", "publish"],
	project_admin: ["read", "run", "edit", "session_build", "publish", "manage"],
} as const satisfies Record<ProjectRole, readonly Scope[]>;

/**
 * 项目令牌能带的范围：没有「管理」。成员和角色的管理、Agent 和它的凭据、飞书机器人的管理只能由人做；
 * 令牌行里写了 `manage` 也不认（签发令牌的接口在 #491，它不该签出带管理的项目令牌，这里是第二道防线）。
 */
export const PROJECT_TOKEN_SCOPES: readonly Scope[] = SCOPES.filter((scope) => scope !== "manage");

/** 平台管理员在每个项目里都有项目管理员的权限。 */
export const PLATFORM_ADMIN_SCOPES: readonly Scope[] = ROLE_SCOPES.project_admin;

/**
 * 「接口作用在哪类资源上 × 只读或写」查出范围（ADR 0029「一处检查」的范围表）。`write` 是 null 的类别，
 * 没有任何人和程序（令牌、登录）能写：只有 Agent 凭据能写，走它自己的接口清单（./credential-routes.ts）。
 * 写成 `Record<ResourceKind, …>`：契约里加一个资源类别，这里不加一行就过不了类型检查，不会悄悄没人管。
 */
export const SCOPE_TABLE = {
	scenario: { write: "edit" },
	run: { write: "run" },
	task: { write: null },
	package: { write: "publish" },
	agent: { write: "manage" },
	feishu_bot: { write: "manage" },
	// 建会话、对它说话、停止它，都是在驱动对场景的修改（ADR 0029 的范围表没有会话这一行，ADR 0027 补记）。
	session: { write: "edit" },
	system: { write: null },
	// 账号不属于项目，不走范围表：各接口认哪种凭据由 `ACCOUNT_ROUTES`（./access-rules.ts）规定。
	account: { write: null },
} as const satisfies Record<ResourceKind, { write: Scope | null }>;

/**
 * 一个接口要什么范围：只读都是「读」；写看「作用在哪类资源上」：声明了 `creates` 取它，否则取 `resource.kind`。
 * 返回 null 表示没有人和程序能调用它（任务的写）。
 */
export function requiredScope(route: {
	effect: Effect;
	resource: { kind: ResourceKind };
	creates?: ResourceKind | undefined;
}): Scope | null {
	if (route.effect === "read") return "read";
	return SCOPE_TABLE[route.creates ?? route.resource.kind].write;
}

const isScope = (name: string): name is Scope => (SCOPES as readonly string[]).includes(name);

/**
 * 有用户的凭据在一个项目里的有效范围：令牌的范围和用户此刻在这个项目的范围取交集；
 * 登录没有自己的范围（`granted` 为 undefined），就是用户的范围。令牌里不认识的范围名没有意义，丢掉。
 */
export function effectiveScopes(
	userScopes: readonly Scope[],
	granted: readonly string[] | undefined,
): Scope[] {
	if (granted === undefined) return [...userScopes];
	return granted.filter(isScope).filter((scope) => userScopes.includes(scope));
}
