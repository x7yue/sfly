import type { z } from "zod";
import {
	EFFECTS,
	RESOURCE_KINDS,
	type ResourceKind,
	type ResourceTarget,
	type RouteDef,
} from "./contract.js";

/**
 * 接口声明（约定 10：`summary`、`effect`、`resource`，以及可选的 `creates`、`removes`）的检查。
 * 类型已经保证每个接口写了必填的三项，这里检查写出来的值站得住：说明不是空的，资源类别在枚举里，
 * 定位的字段真的在请求里，`creates` 和 `removes` 只出现在写接口上、互不同时出现；
 * 再加守着下游的前提：GET 一定是只读，DELETE 一定声明 `removes`，非 GET 的只读接口一定登记在
 * {@link NON_GET_READS}；`{ params }` 定位用的一定是路径里的第一个参数；
 * 接口的路径前缀和资源类别一定对得上 {@link PATH_KINDS}（`system` 的接口就是这张表里的 `system` 项：
 * 按鉴权的设想它们不带项目、不需要凭据，所以写错一个就是悄悄多了一个公开的接口，必须过这张表）。
 * 契约测试对 `httpContract` 运行它；路由清单导出时也运行它，有问题就不导出。
 */

/** 一个路径前缀（`exact` 时是一条完整的路径）对应的资源类别，以及为什么。 */
export interface PathKind {
	kind: ResourceKind;
	why: string;
	/**
	 * 只匹配和它完全相同的路径模板，不匹配它下面的路径。`system` 的每一项都要写它：新增一个 `system` 接口一定要在表里
	 * 加一项（审查时看得见），不会因为路径正好落在已有的前缀下就悄悄成了公开的接口。
	 */
	exact?: true;
}

/**
 * 路径前缀 → 这个前缀下的接口作用在哪类资源上（`resource.kind`），以及为什么。键是按路径段匹配的前缀
 * （`/docs` 匹配 `/docs/:page.md`，不匹配 `/docs-x`），取最长的那一项。
 *
 * - 每个接口的路径都要落在某一项上，声明的 `kind` 要和那一项一致：写错 `kind`（尤其是写成 `system`）、
 *   新增一个前缀都会报错，要改这张表，审查时看得见。
 * - `system` 项就是「平台自身」的名单：这类接口按鉴权的设想不带项目、不需要凭据，所以每一项都要写清楚为什么它是平台自身的，
 *   并且一项只对应一条完整的路径（`exact`）：新增一个 `system` 接口一定要在这里加一项。
 * - 前缀下有例外时，为例外写一个更长的前缀并写明理由，不要为了过检查改声明。
 * - 加一个资源类别时，在这里写它的路径前缀；一个类别没有任何前缀、或者一项没有接口用，契约测试都会报错。
 */
export const PATH_KINDS: Readonly<Record<string, PathKind>> = {
	"/orchestrations": {
		kind: "scenario",
		why: "场景，以及场景的版本、运行预设、预检、场景的运行：路径里的 :id 都是场景 id",
	},
	"/runs": {
		kind: "run",
		why: "运行，以及运行的日志、指标、关注项、事件流：路径里的 :id 是运行 id",
	},
	"/tasks": { kind: "task", why: "任务的日志、动作、产物：路径里的 :id 是任务 id，不是运行 id" },
	"/projects/:project/packages": {
		kind: "package",
		why: "节点包，以及它的版本、节点类型、归档下载、发布：路径里的 :name 是包名",
	},
	"/projects/:project/agents": {
		kind: "agent",
		why: "Agent 列表、立即更新、凭据的签发和吊销、停用和恢复：路径里的 :name 是 Agent 名称",
	},
	"/projects/:project/dev-agents": {
		kind: "dev_agent",
		why: "我的开发 Agent（ADR 0029「凭据」）：在项目下新建和吊销，名字由控制面按「dev-登录名-主机」生成，只认有用户的人的凭据",
	},
	"/feishu-bots": {
		kind: "feishu_bot",
		why: "飞书机器人的登记、改、删、引用、测试消息：路径里的 :name 是机器人名称",
	},
	"/projects/:project/dashboard": {
		kind: "run",
		why: "项目的控制台统计以运行为主（窗口内的运行结果、运行中的运行、最近结束的运行），Agent 在线数只是附带；都只算路径里这个项目的",
	},
	"/auth": {
		kind: "account",
		why: "账号类接口：登录、登出、当前用户、改自己的密码、初始化第一个管理员；定位在发起请求的用户自己，路径不带项目（ADR 0029「凭据」）",
	},
	"/users": {
		kind: "account",
		why: "平台管理员管理账号：列出、建用户、停用和恢复、重置密码；不属于任何项目，只认平台管理员的登录",
	},
	"/account": {
		kind: "account",
		why: "自己的账号：个人令牌的签发、列出、吊销；定位在发起请求的用户自己，不属于任何项目（ADR 0029「凭据」）",
	},
	// 路径里的项目一律写成 `/projects/:project/…`：前缀里的 `:project` 就是路径模板里的 `:project`，按字面匹配。
	// 每一类属于项目的资源（项目令牌、以后的成员、项目密钥）各写一项，#488 把现有接口搬到项目下时照这个写
	// （`/projects/:project/orchestrations` 等）：新增一类要改这张表，审查时看得见。
	"/projects/:project/tokens": {
		kind: "project",
		why: "项目令牌的签发、列出、吊销：项目令牌是项目的一部分（服务账号），定位用路径里的 :project，要「管理」范围",
	},
	"/projects/:project/workbench": {
		kind: "project",
		why: "项目的工作台（助手的会话在哪台 Agent 上做事）：登记属于项目自己的设置，定位用路径里的 :project，要「管理」范围",
	},
	"/projects/:project/orchestrations": {
		kind: "scenario",
		why: "项目里的场景：列出和新建，路径里的 :project 是项目标识（场景的集合属于项目）",
	},
	"/projects/:project/runs": {
		kind: "run",
		why: "项目里的运行记录：跨场景的运行列表，路径里的 :project 是项目标识",
	},
	"/projects/:project/sessions": {
		kind: "session",
		why: "项目里的会话：列出和新建，路径里的 :project 是项目标识（会话的集合属于项目）",
	},
	"/sessions": {
		kind: "session",
		why: "一个会话和它的事件、发话、停止：路径里的 :id 是会话 id，项目从会话得出",
	},
	"/health": { kind: "system", exact: true, why: "健康检查：控制面自己的状态，不属于任何项目" },
	"/docs": { kind: "system", exact: true, why: "用户文档的目录：公开的说明文字，不属于任何项目" },
	"/docs/:page.md": {
		kind: "system",
		exact: true,
		why: "一页用户文档的 Markdown 原文：给 curl 和 AI 编程助手读，公开的说明文字",
	},
	"/docs/skills/:skill/:file": {
		kind: "system",
		exact: true,
		why: "给 AI 编程助手的 skill 文件：公开的说明文字，与 sfly init 写进项目的是同一份",
	},
	"/llms.txt": {
		kind: "system",
		exact: true,
		why: "给 AI 编程助手的文档索引：公开的说明文字",
	},
	"/sdk/python": {
		kind: "system",
		exact: true,
		why: "控制面提供的 SDK 运行时 wheel 的列表：装 sfly 用的，与具体场景无关",
	},
	"/sdk/python/:version/:filename": {
		kind: "system",
		exact: true,
		why: "下载一个 SDK 运行时 wheel：Agent 和开发机装 sfly 用的，与具体场景无关",
	},
	"/sdk/project-settings": {
		kind: "system",
		exact: true,
		why: "sfly init 写进新节点包目录的配置（控制面版本、sfly 索引、镜像）：与具体场景无关",
	},
	"/simple/": {
		kind: "system",
		exact: true,
		why: "控制面的包索引（PEP 503）的根页面：uv 从这里装 sfly 和 sfly-std，与具体场景无关",
	},
	"/simple/:package/": {
		kind: "system",
		exact: true,
		why: "控制面的包索引的项目页：SDK wheel、sfly-std wheel 的下载链接，与具体场景无关",
	},
	"/simple/sfly-std/files/:filename": {
		kind: "system",
		exact: true,
		why: "下载包索引里的一个 sfly-std wheel：Agent 和开发机装 sfly-std 用的，与具体场景无关",
	},
	"/install.sh": {
		kind: "system",
		exact: true,
		why: "Agent 的一键安装脚本：curl | sh 的时候还没有身份",
	},
	"/agent/binaries": {
		kind: "system",
		exact: true,
		why: "Agent 二进制的列表和安装脚本地址：是「装一个 Agent 用的软件」，不是某台 Agent",
	},
	"/agent/binaries/:version/:arch": {
		kind: "system",
		exact: true,
		why: "下载一个 Agent 二进制：是「装一个 Agent 用的软件」，不是某台 Agent",
	},
	"/client": {
		kind: "system",
		exact: true,
		why: "API 客户端安装包的列表：软件，与具体场景无关",
	},
	"/client/:version/:filename": {
		kind: "system",
		exact: true,
		why: "下载一个 API 客户端安装包：软件，与具体场景无关",
	},
};

/** 检查用到的两张表；测试可以换成自己的。 */
export interface DeclarationRules {
	pathKinds: Readonly<Record<string, PathKind>>;
	nonGetReads: Readonly<Record<string, string>>;
	/** 照约定路径要带 `:project`、还没有搬过去的接口（{@link PROJECT_PATH_PENDING}）。 */
	projectPathPending?: Readonly<Record<string, string>>;
}

/**
 * 照「路径里带不带 `:project`」的约定（{@link checkProjectInPath}）该带、还没有搬到 `/projects/:project/…` 下的接口：#488 按领域
 * 分几个 PR 搬，每搬一个领域就从这里删掉它的接口。键是 `方法 路径`；契约测试检查表里的接口都在契约里（搬了就不在了）。
 */
export const PROJECT_PATH_PENDING: Readonly<Record<string, string>> = {
	"GET /feishu-bots": "#488 飞书机器人",
	"POST /feishu-bots": "#488 飞书机器人",
	"PATCH /feishu-bots/:name": "#488 飞书机器人",
	"GET /feishu-bots/:name/references": "#488 飞书机器人",
	"DELETE /feishu-bots/:name": "#488 飞书机器人",
	"POST /feishu-bots/:name/test": "#488 飞书机器人",
};

/**
 * 方法不是 GET、声明为只读的接口：一眼看不出它只读，所以每一个都要在这里登记，写明为什么只读、调用后会留下什么
 * （只能是不影响任何资源内容的东西：访问日志、最后访问时间、内存里的临时状态；什么都不留下就写什么都不留下）。
 * 键是 `方法 路径`（路径模板）。契约测试检查表里的接口都存在、都声明为只读，非 GET 的只读接口都在表里；
 * 控制面的测试（read-only-routes.test.ts）对这里的接口同样要求库里和数据目录里没有变化，
 * 所以只写内存的才能登记；写库的（访问日志）要先在那个测试里单独说明。
 * GET 一定是只读，不用登记。
 */
export const NON_GET_READS: Readonly<Record<string, string>> = {
	"POST /orchestrations/:id/edits/check":
		"检查一组局部编辑：用 POST 只是因为请求体是一组操作；不改库、数据目录和内存，什么都不留下",
	"POST /orchestrations/:id/check":
		"检查一份场景文档：用 POST 只是因为请求体是一整份文档；不改库、数据目录和内存，什么都不留下",
};

export const DECLARATION_RULES: DeclarationRules = {
	pathKinds: PATH_KINDS,
	nonGetReads: NON_GET_READS,
	projectPathPending: PROJECT_PATH_PENDING,
};

/** 说明的长度上限：它是一句话，在 `sfly api --list` 的一行里显示。 */
export const SUMMARY_MAX_LENGTH = 80;

const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** 路径里用来写项目的参数名（ADR 0029：`/projects/:project/…`）。 */
export const PROJECT_PARAM = "project";

/** 路径模板里的参数名（不含末尾的 `*`）。 */
export function pathParamNames(path: string): string[] {
	return [...path.matchAll(PATH_PARAM)].map((found) => found[1] as string);
}

/**
 * 判断 `collection`（路径里不带任何定位资源的参数）时看的参数名：`/projects/:project/…` 开头的路径，第一个参数
 * `:project` 只是限定项目（ADR 0029「项目从请求的哪里来」：列表和新建的路径带项目），不是在定位某个已有的资源，
 * 所以不算在内；其余路径和 {@link pathParamNames} 一样。用 `{ params: "project" }` 定位项目本身（资源类别 `project`）
 * 不受这条影响。
 */
function paramsBesidesProject(path: string): string[] {
	const names = pathParamNames(path);
	return isProjectScoped(path) ? names.slice(1) : names;
}

/** 路径是不是 `/projects/:project/…`（项目写在路径里：列表、新建，以及按名字定位的资源）。 */
const isProjectScoped = (path: string): boolean => path.startsWith(`/projects/:${PROJECT_PARAM}/`);

/**
 * 用 ID 定位的资源类别（ADR 0029「项目从请求的哪里来」）：项目从那个资源所在的项目得出，路径里不带 `:project`——
 * ID 已经确定了项目，再带一份就多出「两者不一致」这种情况，访问检查也不会核对 ID 属于路径里的那个项目。
 * 和访问检查（`apps/server/src/auth/access-rules.ts` 的 `locatorOf`）认的是同一批。
 */
export const ID_LOCATED_KINDS: readonly ResourceKind[] = ["scenario", "run", "task", "session"];

/** 对象 schema 的字段名；不是对象（或套了一层包装也认不出对象）时返回 undefined。 */
function fieldNames(schema: z.ZodType | undefined): string[] | undefined {
	let def = schema?._zod.def as { type: string; [key: string]: unknown } | undefined;
	for (let depth = 0; def && depth < 8; depth++) {
		if (def.type === "object") return Object.keys(def.shape as Record<string, unknown>);
		const inner = (def.innerType ?? def.in ?? def.out) as z.ZodType | undefined;
		def = inner?._zod.def as typeof def;
	}
	return undefined;
}

/** 接口的查询参数名；没有声明查询参数时是空的。 */
export function queryParamNames(def: { query?: z.ZodType | undefined }): string[] {
	return fieldNames(def.query) ?? [];
}

const label = (def: Pick<RouteDef, "method" | "path">) => `${def.method} ${def.path}`;

function checkTarget(def: RouteDef, kind: ResourceKind, target: ResourceTarget): string[] {
	const problems: string[] = [];
	const hasPathParams = paramsBesidesProject(def.path).length > 0 || def.path.endsWith("*");
	if (typeof target === "string") {
		if (target === "collection" && hasPathParams) {
			problems.push(
				"resource.target 写了 collection，但路径里有参数：有参数就是在定位某个资源，写 { params: 参数名 }",
			);
		}
		if (target === "upload" && !("upload" in def && def.upload)) {
			problems.push("resource.target 写了 upload，但接口不是上传（没有标 upload: true）");
		}
		if (target === "global" && kind !== "system") {
			problems.push("resource.target 的 global 只用于 system");
		}
		if (target === "self" && kind !== "account") {
			problems.push("resource.target 的 self 只用于 account（发起请求的用户自己）");
		}
		if (target === "self" && hasPathParams) {
			problems.push(
				"resource.target 写了 self，但路径里有参数：self 是发起请求的用户自己，管理别人的账号写 { params: 参数名 }",
			);
		}
		if (kind === "system" && target !== "global") {
			problems.push("system 没有具体的那一个，resource.target 写 global");
		}
		return problems;
	}
	if (kind === "system") problems.push("system 没有具体的那一个，resource.target 写 global");
	if ("params" in target) {
		const names = pathParamNames(def.path);
		if (!names.includes(target.params)) {
			problems.push(`resource.target 的路径参数 ${target.params} 不在路径 ${def.path} 里`);
			return problems;
		}
		// `/projects/:project/…` 的路径里 :project 只限定项目，定位用的是它之后的第一个参数。
		const located = paramsBesidesProject(def.path);
		if (isProjectScoped(def.path) && ID_LOCATED_KINDS.includes(kind)) {
			// 用 ID 定位的类别在这类路径上只接受 collection：写 { params }（不论 :project 还是别的参数）都拒绝。
			problems.push(
				`${kind} 用 ID 定位，路径带 :${PROJECT_PARAM}（/projects/:${PROJECT_PARAM}/…）时只能写 collection（列表和新建）：` +
					`访问检查对这类路径只按路径里的项目判断，不会核对 { params: "${target.params}" } 指的资源属于哪个项目。` +
					`要按 ID 定位，路径写成不带 /projects/:${PROJECT_PARAM} 的写法（例如 /sessions/:id/…），定位写 { params: "id" }`,
			);
		} else if (isProjectScoped(def.path) && located.length > 0) {
			if (kind === "project") {
				// 项目本身和它的管理面（项目令牌，以后的成员、项目密钥）：定位的就是路径里的 :project（要的范围、检查的项目都是它），
				// 它之后的参数（令牌 ID…）是项目名下的子项，不算在定位。
				if (target.params !== PROJECT_PARAM) {
					problems.push(
						`project 定位的是项目本身，resource.target 写 { params: "${PROJECT_PARAM}" }：访问检查只认路径里的 :${PROJECT_PARAM}，:${located[0]} 是它名下的子项`,
					);
				}
			} else if (target.params === PROJECT_PARAM) {
				problems.push(
					`resource.target 写了 { params: "${PROJECT_PARAM}" }，但路径里还有 :${located[0]}：它定位的是项目下的那一个资源，不是项目本身；` +
						`改成 { params: "${located[0]}" }。（定位项目本身的路径写资源类别 project，见上一条）`,
				);
			} else if (located[0] !== target.params) {
				problems.push(
					`resource.target 的路径参数 ${target.params} 不是 :${PROJECT_PARAM} 之后的第一个参数 :${located[0]}：定位用的是它（${located[0]} 之后的参数是它名下的子项）。` +
						`改成 { params: "${located[0]}" }；确有例外时在 checkTarget（http/declarations.ts）里放宽这条规则并写明理由`,
				);
			}
		} else if (names[0] !== target.params) {
			problems.push(
				`resource.target 的路径参数 ${target.params} 不是路径里的第一个参数 :${names[0]}：定位用的是路径里的第一个参数（它标识路径的主体资源，${names[0]} 之后的参数是它名下的子项）。` +
					`改成 { params: "${names[0]}" }；确有例外时在 checkTarget（http/declarations.ts）里放宽这条规则并写明理由`,
			);
		}
		return problems;
	}
	if (!("query" in target) && !("body" in target)) {
		problems.push(
			"resource.target 要写 { params }、{ query }、{ body }、collection、upload 或 global",
		);
		return problems;
	}
	// `/projects/:project/…` 下用 ID 定位的类别只接受 collection（列表和新建）：访问检查看到路径里有 :project 就按路径的项目
	// 查，不会去核对 query 或 body 里的那个 ID 属于哪个项目——写成 { query }、{ body } 就等于绕过了「ID 决定项目」。
	if (isProjectScoped(def.path) && ID_LOCATED_KINDS.includes(kind)) {
		problems.push(
			`${kind} 用 ID 定位，路径带 :${PROJECT_PARAM}（/projects/:${PROJECT_PARAM}/…）时只能写 collection（列表和新建）：` +
				`访问检查只按路径里的项目判断，不会核对 ${"query" in target ? "query" : "body"} 里的 ID 属于哪个项目。` +
				`要按 ID 定位，路径写成不带 /projects/:${PROJECT_PARAM} 的写法（例如 /sessions/:id/…），定位写 { params: "id" }`,
		);
		return problems;
	}
	const part = "query" in target ? "query" : "body";
	const field = "query" in target ? target.query : target.body;
	const schema = part === "query" ? def.query : "body" in def ? def.body : undefined;
	const names = fieldNames(schema);
	if (names === undefined) {
		problems.push(`resource.target 指向 ${part} 的字段 ${field}，但接口没有对象形式的 ${part}`);
	} else if (!names.includes(field)) {
		problems.push(`resource.target 指向 ${part} 的字段 ${field}，它不在 ${part} 里`);
	}
	return problems;
}

/** `effect`、`creates`、`removes` 之间、以及和 HTTP 方法之间的关系。 */
function checkEffect(def: RouteDef, rules: DeclarationRules): string[] {
	const problems: string[] = [];
	const key = `${def.method} ${def.path}`;
	const creates: unknown = def.creates;
	const removes: unknown = def.removes;
	if (def.method === "GET" && def.effect !== "read") {
		problems.push(
			"GET 要声明为只读（effect: read）：有副作用的接口用别的方法，下游按「所有 GET 都没有副作用」判断",
		);
	}
	if (def.method !== "GET" && def.effect === "read" && !(key in rules.nonGetReads)) {
		problems.push(
			"方法不是 GET 的只读接口要登记在 NON_GET_READS（./declarations.ts），写明为什么只读、会留下什么；没有登记的写接口应声明 effect: write",
		);
	}
	if (creates !== undefined) {
		if (!(RESOURCE_KINDS as readonly unknown[]).includes(creates)) {
			problems.push(
				`creates 要写 ${RESOURCE_KINDS.join("、")} 之一，收到 ${JSON.stringify(creates)}`,
			);
		}
		if (def.effect === "read") problems.push("只读接口不能声明 creates（新建就是写）");
	}
	if (removes !== undefined) {
		if (removes !== true) problems.push("removes 只能写 true");
		if (def.effect === "read") problems.push("只读接口不能声明 removes（删除、归档就是写）");
		if (creates !== undefined) {
			problems.push("creates 和 removes 不能同时声明：一个接口要么新建、要么让资源不再可用");
		}
	}
	if (def.method === "DELETE" && removes !== true) {
		problems.push("DELETE 接口要声明 removes: true（让资源不再可用）；删除不了的不要用 DELETE");
	}
	return problems;
}

const pathSegments = (path: string) => path.split("/").filter((segment) => segment !== "");

/** 路径落在 `pathKinds` 的哪一项上（按路径段匹配的最长前缀）。 */
function pathKindFor(
	path: string,
	pathKinds: Readonly<Record<string, PathKind>>,
): { prefix: string; entry: PathKind } | undefined {
	const own = pathSegments(path);
	let best: { prefix: string; entry: PathKind; length: number } | undefined;
	for (const [prefix, entry] of Object.entries(pathKinds)) {
		const parts = pathSegments(prefix);
		const sameLength = entry.exact ? parts.length === own.length : parts.length <= own.length;
		const matches = sameLength && parts.every((part, i) => part === own[i]);
		if (matches && (best === undefined || parts.length > best.length)) {
			best = { prefix, entry, length: parts.length };
		}
	}
	return best;
}

/**
 * 路径里的项目一律写成 `/projects/:project/…`（ADR 0029「项目从请求的哪里来」）：访问检查按路径里的 `:project` 参数得出项目，
 * 所以 `:project` 不能有别的写法或位置，别的东西也不能占用这个名字（公开的 `/simple/:package/` 里指 PEP 503 的包，
 * 不叫 `:project`）；`/projects/…` 下面的路径也要这样写，不能写成别的参数名。
 */
function checkProjectPath(def: RouteDef): string[] {
	const segments = pathSegments(def.path);
	const problems: string[] = [];
	const projectParam = segments.findIndex((segment) => segment === `:${PROJECT_PARAM}`);
	if (projectParam !== -1 && !(projectParam === 1 && segments[0] === "projects")) {
		problems.push(
			`路径 ${def.path} 里的 :${PROJECT_PARAM} 位置不对：项目一律写成 /projects/:${PROJECT_PARAM}/…（访问检查据此得出项目）；` +
				"别的东西不要叫 :project（PEP 503 的包叫 :package）",
		);
	}
	if (segments[0] === "projects" && segments.length > 1 && segments[1] !== `:${PROJECT_PARAM}`) {
		problems.push(
			`路径 ${def.path}：/projects/ 后面一段要写 :${PROJECT_PARAM}（项目一律写成 /projects/:${PROJECT_PARAM}/…）`,
		);
	}
	return problems;
}

/**
 * 路径里带不带 `:project`，由声明定（ADR 0029「项目从请求的哪里来」）：`target` 是 `collection`、`upload`，或者按名字定位
 * （Agent、节点包、飞书机器人、开发 Agent；项目本身写 `{ params: "project" }`），路径要写成 `/projects/:project/…`，项目从路径取；
 * 按 ID 定位的（{@link ID_LOCATED_KINDS}）路径里不能有 `:project`，项目从资源得出（这一半由 `checkTarget` 查）；
 * `system`、`account` 不属于项目，路径里都没有。这样「项目从哪来」不用另外声明。
 */
function checkProjectInPath(
	def: RouteDef,
	kind: ResourceKind,
	target: ResourceTarget,
	rules: DeclarationRules,
): string[] {
	const scoped = isProjectScoped(def.path);
	if (kind === "system" || kind === "account") {
		return scoped ? [`${kind} 不属于项目，路径里不能有 /projects/:${PROJECT_PARAM}`] : [];
	}
	// 按名字定位不管名字写在路径参数、查询参数还是请求体里，项目都要在路径里。
	const located = typeof target === "object";
	const needs =
		target === "collection" || target === "upload" || (located && !ID_LOCATED_KINDS.includes(kind));
	if (!needs || scoped || label(def) in (rules.projectPathPending ?? {})) return [];
	return [
		`${target === "collection" ? "列表和新建" : target === "upload" ? "上传" : "按名字定位"}的接口，路径要写成 /projects/:${PROJECT_PARAM}/…：` +
			"项目从路径里取（按 ID 定位的才从资源得出）",
	];
}

/** 接口的路径前缀和声明的资源类别要对得上 {@link PATH_KINDS}。 */
function checkPathKind(def: RouteDef, kind: ResourceKind, rules: DeclarationRules): string[] {
	const found = pathKindFor(def.path, rules.pathKinds);
	if (found === undefined) {
		const [first = ""] = pathSegments(def.path);
		return [
			`路径 ${def.path} 不在 PATH_KINDS（http/declarations.ts）里：新增接口要在那张表里加一项` +
				` "/${first}": { kind: …, why: "…" }（写前缀，这个前缀下的接口都作用在同一类资源上）；` +
				`system 的接口要把这条完整的路径写成一项 "${def.path}": { kind: "system", exact: true, why: "…" }：` +
				"system 按鉴权的设想不带项目、不需要凭据，所以每一条都单独列出来，并写明为什么它是平台自身的",
		];
	}
	const { prefix, entry } = found;
	if (entry.kind === kind) return [];
	const wrongSystem =
		kind === "system"
			? `声明成 system 就等于这个接口不带项目、不需要凭据（公开）；它不在 system 的名单里，`
			: entry.kind === "system"
				? `${prefix} 是平台自身的接口（system，不带项目、不需要凭据），`
				: "";
	return [
		`resource.kind 写的是 ${kind}，PATH_KINDS 里 ${prefix} 对应 ${entry.kind}（${entry.why}）。${wrongSystem}` +
			`声明写错了就改成 ${entry.kind}；这个接口确实是例外时，在 PATH_KINDS 里为它加一个更长的前缀并写明理由，不要为了过检查改别的`,
	];
}

/**
 * 检查那两张表（{@link PATH_KINDS}、{@link NON_GET_READS}）和契约对得上：类别合法、写了理由、
 * 每一项都有接口在用（改名或删了接口，表里的残留会报错），登记的只读接口都存在、都声明为只读。
 */
export function checkDeclarationTables(
	contract: readonly RouteDef[],
	rules: DeclarationRules = DECLARATION_RULES,
): string[] {
	const problems: string[] = [];
	const used = new Set(contract.map((def) => pathKindFor(def.path, rules.pathKinds)?.prefix));
	for (const [prefix, entry] of Object.entries(rules.pathKinds)) {
		if (!prefix.startsWith("/")) problems.push(`PATH_KINDS 的键 ${prefix} 要以 / 开头`);
		if (!(RESOURCE_KINDS as readonly unknown[]).includes(entry.kind)) {
			problems.push(`PATH_KINDS 的 ${prefix}：kind 要写 ${RESOURCE_KINDS.join("、")} 之一`);
		}
		if (entry.why.trim() === "") problems.push(`PATH_KINDS 的 ${prefix}：要写明为什么`);
		if (entry.kind === "system" && entry.exact !== true) {
			problems.push(
				`PATH_KINDS 的 ${prefix} 是 system，要写 exact: true：system 的每条路径都要单独列出来，新增一个 system 接口就要在这里加一项`,
			);
		}
		if (!used.has(prefix)) {
			problems.push(`PATH_KINDS 的 ${prefix} 没有接口在用：接口改名或删掉了，把这一项一起改掉`);
		}
	}
	const known = new Map(contract.map((def) => [label(def), def]));
	for (const key of Object.keys(rules.projectPathPending ?? {})) {
		if (!known.has(key)) {
			problems.push(
				`PROJECT_PATH_PENDING 的 ${key} 不在契约里：搬到 /projects/:${PROJECT_PARAM}/… 之后把这一项删掉`,
			);
		}
	}
	for (const [key, what] of Object.entries(rules.nonGetReads)) {
		const def = known.get(key);
		if (def === undefined) problems.push(`NON_GET_READS 的 ${key} 不在契约里：接口改名或删掉了`);
		else if (def.effect !== "read") problems.push(`NON_GET_READS 的 ${key} 没有声明为只读`);
		if (what.trim() === "") problems.push(`NON_GET_READS 的 ${key}：要写明为什么只读、会留下什么`);
	}
	return problems;
}

/**
 * 每个资源类别至少有一个路径前缀（加了类别没在 {@link PATH_KINDS} 里写前缀会报错）。只看表，不看契约；
 * 契约测试对真正的表运行它。
 */
export function checkPathKindsCover(rules: DeclarationRules = DECLARATION_RULES): string[] {
	const kinds = new Set(Object.values(rules.pathKinds).map((entry) => entry.kind));
	return RESOURCE_KINDS.filter((kind) => !kinds.has(kind)).map(
		(kind) =>
			`资源类别 ${kind} 在 PATH_KINDS 里没有任何路径前缀：加了类别要在那张表里写它的前缀（http/declarations.ts）`,
	);
}

/** 检查一组接口的声明；返回问题列表（每条以 `方法 路径` 开头），空表示全部站得住。 */
export function checkRouteDeclarations(
	contract: readonly RouteDef[],
	rules: DeclarationRules = DECLARATION_RULES,
): string[] {
	const problems: string[] = [];
	const add = (def: RouteDef, text: string) => problems.push(`${label(def)}：${text}`);
	for (const def of contract) {
		const summary: unknown = def.summary;
		if (typeof summary !== "string" || summary.trim() === "") {
			add(def, "缺少 summary（一句话说明这个接口做什么）");
		} else if (summary !== summary.trim() || /[\r\n]/.test(summary)) {
			add(def, "summary 要写成一行，首尾不留空白");
		} else if ([...summary].length > SUMMARY_MAX_LENGTH) {
			add(def, `summary 超过 ${SUMMARY_MAX_LENGTH} 个字：它是一句话，详细的写在注释里`);
		}

		const effect: unknown = def.effect;
		if (!(EFFECTS as readonly unknown[]).includes(effect)) {
			add(def, `effect 要写 ${EFFECTS.join(" 或 ")}，收到 ${JSON.stringify(effect)}`);
		}
		for (const problem of checkEffect(def, rules)) add(def, problem);

		const resource: unknown = def.resource;
		if (typeof resource !== "object" || resource === null) {
			add(def, "缺少 resource（作用在哪类资源上、怎么定位到具体的那一个）");
			continue;
		}
		const { kind, target } = def.resource;
		if (!(RESOURCE_KINDS as readonly unknown[]).includes(kind)) {
			add(
				def,
				`resource.kind 要写 ${RESOURCE_KINDS.join("、")} 之一，收到 ${JSON.stringify(kind)}`,
			);
			continue;
		}
		if (target === undefined || target === null) {
			add(def, "缺少 resource.target（用哪个字段定位，或者 collection / upload / global）");
			continue;
		}
		for (const problem of checkTarget(def, kind, target)) add(def, problem);
		for (const problem of checkProjectPath(def)) add(def, problem);
		for (const problem of checkProjectInPath(def, kind, target, rules)) add(def, problem);
		for (const problem of checkPathKind(def, kind, rules)) add(def, problem);
	}
	return problems;
}
