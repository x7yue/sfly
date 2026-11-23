import { z } from "zod";
import { hasUnsafeNameCharacter } from "../text-safety.js";
import { CurrentUser, PASSWORD_MAX_LENGTH } from "./accounts.js";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 令牌的接口契约（约定见 ./contract.ts，ADR 0029「凭据」）：命令行、API 客户端、自建页面和自动化不能用 Cookie，
 * 只能用请求头里的令牌。控制面只存令牌的 SHA-256 哈希和前缀，原值只在签发那一次的响应里出现一次。
 *
 * - **个人令牌**属于用户自己，不属于项目：签发、列出、吊销定位在发起请求的用户自己（资源类别 `account`，
 *   路径 `/account/tokens`），不走项目的范围表，各接口认哪种凭据写在 `ACCOUNT_ROUTES`
 *   （apps/server/src/auth/access-rules.ts）。签发时可选限定一个项目、一部分范围和过期时间。
 * - **项目令牌**属于项目（服务账号），在 `/projects/:project/tokens` 下签发、列出、吊销（资源类别 `project`，
 *   用路径里的 `:project` 定位项目本身），要「管理」范围；项目令牌自己不能带「管理」范围。
 *
 * 令牌不能签发令牌：这些接口里的签发只认人（登录 Cookie；个人令牌还可以用账号密码换，`sfly login` 用）。
 * 这些接口都只给控制台和命令行用，不进 API 客户端（`client: false`）。
 */

/**
 * 范围（ADR 0029 的范围表）：检查只看范围，不看角色名；以后加「只能触发运行」这类角色，只是多一组范围。
 * 控制面的访问检查和控制台的令牌页都从这里取。
 */
export const SCOPES = ["read", "run", "edit", "session_build", "publish", "manage"] as const;
export type Scope = (typeof SCOPES)[number];

/** 范围的中文名（GLOSSARY「令牌」里的词）：写进拒绝的说明，控制台的令牌页也显示它。 */
export const SCOPE_LABELS = {
	read: "读",
	run: "运行",
	edit: "编辑",
	session_build: "会话构建",
	publish: "发布",
	manage: "管理",
} as const satisfies Record<Scope, string>;

/** 令牌的名称（「经 …」记它，所以要认得出是哪一个）：去掉首尾空白后 1–64 个字符，不含控制字符和看不见的格式字符（`text-safety.ts`），同一个所有者名下没有两个有效的同名令牌。 */
export const TOKEN_NAME_MAX_LENGTH = 64;
export const TokenName = z
	.string()
	.trim()
	.min(1, "令牌的名称不能为空")
	.max(TOKEN_NAME_MAX_LENGTH, `令牌的名称不能超过 ${TOKEN_NAME_MAX_LENGTH} 个字符`)
	.refine(
		(name) => !hasUnsafeNameCharacter(name),
		"令牌的名称里不能有控制字符（换行、转义序列等）和看不见的格式字符（零宽字符、双向文字的控制字符）",
	);

/** 过期时间：从签发起算的天数；不写表示不过期。 */
export const TOKEN_MAX_EXPIRY_DAYS = 3650;
const ExpiresInDays = z
	.int()
	.min(1, "有效期至少 1 天")
	.max(TOKEN_MAX_EXPIRY_DAYS, `有效期不能超过 ${TOKEN_MAX_EXPIRY_DAYS} 天`);

const TokenScopes = z.array(z.enum(SCOPES)).min(1, "范围不能为空").max(SCOPES.length);

/** 令牌原值的前缀（库里 `prefix` 列存前缀加原值开头的几个字符）：日志、列表和打码规则据此认出是哪一种。 */
export const TOKEN_PREFIXES = {
	personal: "sfly_pat_",
	project: "sfly_prj_",
	session: "sfly_ses_",
	task: "sfly_tsk_",
	agent: "sfly_agt_",
} as const;

/**
 * 令牌原值的样子（任何一种前缀加一串字母数字）：日志、运行视图和接口响应里的打码规则按它认出令牌，不用先知道是哪一个
 * （apps/server/src/logs/secrets.ts）。节点或脚本把令牌打印到日志里，控制面写入和读取时都把它换成掩码，
 * 令牌原值不会出现在日志里；宁可多打码，也不漏。
 */
export const TOKEN_VALUE_PATTERN = new RegExp(
	`(?:${Object.values(TOKEN_PREFIXES).join("|")})[A-Za-z0-9_-]{16,}`,
	"g",
);

/**
 * 一个令牌（不含原值）。`project`：个人令牌限定的项目（没有限定为 null）、项目令牌所属的项目；
 * `current`：列出时标出发起请求用的就是这一个（用登录 Cookie 列出时都是 false）。
 */
export const TokenView = z.object({
	id: z.uuid(),
	kind: z.enum(["personal", "project"]),
	name: z.string(),
	/** 展示用的前缀：令牌种类的前缀加原值开头的几个字符，认得出是哪一个，不够用来请求。 */
	prefix: z.string(),
	scopes: z.array(z.string()),
	project: z.string().nullable(),
	created_at: Timestamp,
	/** 没有过期时间为 null。 */
	expires_at: Timestamp.nullable(),
	/** 吊销的时间；没有吊销为 null。 */
	revoked_at: Timestamp.nullable(),
	/** 最后一次使用的时间，精确到分钟（为了不在每个请求上写库，一分钟内的多次使用只记一次）；从没用过为 null。 */
	last_used_at: Timestamp.nullable(),
	/**
	 * 项目令牌的签发人（显示名）：项目令牌属于项目，不随签发人失效（签发人被停用、移出项目之后照样有效），但记着是谁签发的。
	 * 个人令牌（签发人就是所属用户）和这一项记录加进来之前签发的为 null。
	 */
	issued_by: z.string().nullable(),
	current: z.boolean(),
});

/** 刚签发的令牌：`token` 是原值，只在这一次响应里出现，之后任何接口都读不回。 */
export const IssuedToken = TokenView.extend({
	token: z.string(),
});

export const TokenList = z.object({ tokens: z.array(TokenView) });

/**
 * 自己的个人令牌列表，附上令牌所属的用户：命令行靠它知道「自己」是谁（`sfly run … latest` 找自己触发的最近一次运行，
 * 记在运行上的触发人是用户的显示名）；个人令牌不能读 `/auth/me`（只认登录），所以放在这里。
 */
export const PersonalTokenList = TokenList.extend({ user: CurrentUser });

export const TokenIdParams = z.object({ id: z.uuid() });
export const ProjectTokenParams = z.object({ project: z.string() });
export const ProjectTokenIdParams = z.object({ project: z.string(), id: z.uuid() });

export const tokensApi = {
	/** 列出自己的个人令牌（含已吊销、已过期的，带状态）：登录 Cookie 或个人令牌。 */
	listPersonal: endpoint({
		method: "GET",
		path: "/account/tokens",
		summary: "列出自己的个人令牌（名称、前缀、范围、最后使用时间，不含原值）",
		effect: "read",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["tokens", "personal"],
		response: PersonalTokenList,
	}),
	/**
	 * 签发一个个人令牌，响应里的 `token` 是原值，只此一次。认登录 Cookie；没有 Cookie 时用请求体里的账号密码
	 * （`sfly login` 用，登录名或密码不对是 401 `invalid_credentials`，失败太多是 429 `too_many_attempts`）；
	 * 令牌不能签发令牌（403）。范围不写表示签发人此刻能有的全部范围；写了的不能超过签发人此刻的角色
	 * （限定了项目的看他在那个项目里的角色，没限定的看他在所有项目里的角色加起来），超过是 403 `scope_exceeds_role`；
	 * 用的时候还要再和他那时的角色取交集。同名的有效令牌已经存在是 409 `token_name_taken`。
	 */
	issuePersonal: endpoint({
		method: "POST",
		path: "/account/tokens",
		summary: "签发一个个人令牌（原值只在这次响应里出现一次）",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["tokens", "issue-personal"],
		body: z.object({
			name: TokenName,
			/** 不写：签发人此刻能有的全部范围。 */
			scopes: TokenScopes.optional(),
			/** 限定在一个项目里；不写表示不限定。 */
			project: z
				.string()
				.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "项目标识只能用小写字母、数字和连字符")
				.optional(),
			expires_in_days: ExpiresInDays.optional(),
			/** 没有登录 Cookie 时用账号密码换令牌（`sfly login`）：两个都要给。 */
			login_name: z.string().min(1).max(256).optional(),
			password: z
				.string()
				.min(1)
				.max(PASSWORD_MAX_LENGTH * 4)
				.optional(),
		}),
		response: IssuedToken,
	}),
	/**
	 * 吊销一个个人令牌，立即失效，用它打开的事件流关闭。登录 Cookie 可以吊销自己的任何一个；个人令牌只能吊销它自己
	 * （`sfly logout` 用），吊销别的是 403。已经吊销的再吊销是 204。
	 */
	revokePersonal: endpoint({
		method: "DELETE",
		path: "/account/tokens/:id",
		summary: "吊销一个个人令牌（自己的）",
		effect: "write",
		resource: { kind: "account", target: { params: "id" } },
		removes: true,
		client: false,
		key: ["tokens", "revoke-personal"],
		params: TokenIdParams,
		response: z.undefined(),
	}),
	/** 列出项目令牌（含已吊销、已过期的，带状态）：要「管理」范围。 */
	listProject: endpoint({
		method: "GET",
		path: "/projects/:project/tokens",
		summary: "列出项目令牌（名称、前缀、范围、最后使用时间，不含原值）",
		effect: "read",
		resource: { kind: "project", target: { params: "project" } },
		client: false,
		key: ["tokens", "project"],
		params: ProjectTokenParams,
		response: TokenList,
	}),
	/**
	 * 签发一个项目令牌，响应里的 `token` 是原值，只此一次。要「管理」范围，并且只认人（登录 Cookie）：令牌不能签发令牌。
	 * 范围必须写，不能带「管理」（成员和角色的管理只能由人做，400 `manage_scope_not_allowed`），也不能超过签发人此刻的范围
	 * （403 `scope_exceeds_role`）。
	 */
	issueProject: endpoint({
		method: "POST",
		path: "/projects/:project/tokens",
		summary: "签发一个项目令牌（原值只在这次响应里出现一次）",
		effect: "write",
		resource: { kind: "project", target: { params: "project" } },
		client: false,
		key: ["tokens", "issue-project"],
		params: ProjectTokenParams,
		body: z.object({
			name: TokenName,
			scopes: TokenScopes,
			expires_in_days: ExpiresInDays.optional(),
		}),
		response: IssuedToken,
	}),
	/** 吊销一个项目令牌，立即失效，用它打开的事件流关闭。要「管理」范围；已经吊销的再吊销是 204。 */
	revokeProject: endpoint({
		method: "DELETE",
		path: "/projects/:project/tokens/:id",
		summary: "吊销一个项目令牌",
		effect: "write",
		resource: { kind: "project", target: { params: "project" } },
		removes: true,
		client: false,
		key: ["tokens", "revoke-project"],
		params: ProjectTokenIdParams,
		response: z.undefined(),
	}),
};

export type TokenView = z.infer<typeof TokenView>;
export type IssuedToken = z.infer<typeof IssuedToken>;
