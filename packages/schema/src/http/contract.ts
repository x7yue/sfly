import { z } from "zod";

/**
 * HTTP API 契约（ADR 0007）：每个接口在这里用 zod 定义一份请求与响应 schema，
 * 控制面用它校验请求、约束响应（apps/server/src/http/contract-route.ts），
 * 前端用它推导类型、生成 query key，经 API 客户端（@sfly/client）调用，并在开发环境校验响应（apps/web/src/lib/api.ts）。
 *
 * 约定（新增接口照此编写，见 docs/DESIGN-SYSTEM.md「HTTP 契约」一节）：
 *
 * 1. 一个领域一个模块（`http/agents.ts`、`http/packages.ts`…），导出该领域的数据 schema
 *    （名词，如 `AgentView`）和接口表（`agentsApi = { list: endpoint({...}) }`）。
 * 2. 字段名与 JSON 一致，用 snake_case；时间用 `Timestamp`（ISO 8601 字符串）。
 * 3. 响应 schema 只描述形状：用 `z.object`（不用 strict，允许控制面先加字段），
 *    不用 transform / default / coerce——生产环境前端不解析响应，解析前后必须相同。
 * 4. 请求（params / query / body）可以用 coerce、default；控制面拿到的是解析后的值，
 *    校验失败统一返回 400 `invalid_request`，`details` 为 zod 的 issues。
 *    含 NUL（`\u0000`）的输入由控制面在校验前统一拦下：路径参数 404 `not_found`，查询参数与 JSON 请求体 400 `invalid_request`。
 * 5. `key` 是 TanStack Query 的 query key 前缀，第一段是领域名；前端一律用 `queryKey()` 生成，
 *    失效时用 `domainKey(def)`（领域前缀，如 `["packages"]`）让该领域的查询全部重新获取。
 * 6. 错误响应统一为 `ApiErrorBody`。请求校验失败默认是 400 `invalid_request`；需要更具体的错误码时
 *    （例如保存版本的 `base_version_required`）用 `requestError` 按原始请求选出错误码，details 仍是 zod issues。
 * 7. 控制面的每个 HTTP 路由都在契约里（控制面启动时检查，apps/server/src/http/contract-route.ts）：
 *    JSON 接口用 `endpoint`；SSE 用 `stream`（`events` 是事件名 → data 的 schema）；
 *    返回字节流的下载用 `download`。请求体是原始字节的上传（发布节点包、上传产物）用 `endpoint`，
 *    不定义 body，加 `upload: true`，只约束路径参数与 JSON 响应。新增领域模块后加进 ./index.ts 的 `httpApis`。
 * 8. 路由清单（route-manifest.ts，不从包入口导出，只有导出脚本用）从 `httpContract` 导出到
 *    `sdk/python/src/sfly/schemas/routes.json`
 *    （`pnpm gen`，`pnpm gen:check` 保证提交的是最新的），`sfly api` 用它列出接口、校验请求。
 *    请求的 JSON Schema 按输入方向导出：refine 和转换后的约束导不出来，会记在清单的 `notes` 里。
 * 9. 每个接口都写明 `client`：是否进入 API 客户端（ADR 0022）。同一次 `pnpm gen` 从 `httpApis` 生成
 *    API 客户端的类型和路由表（client-export.ts，写到 `packages/client/src/generated/`）：
 *    方法按领域分组，领域名是 `httpApis` 的键，必须等于该领域 JSON 接口 key 第一段的驼峰写法（`feishu-bots` → `feishuBots`）；
 *    请求类型按输入方向、响应类型按输出方向，注释随类型带过去。
 * 10. 每个接口都要声明三件关于它自己的事，类型上必填、没有默认值：`summary`（一句话说明它做什么）、
 *    `effect`（`read` 只读 / `write` 有副作用）、`resource`（作用在哪类资源上、用请求的哪个字段定位到具体的那一个，
 *    见 {@link ResourceRef}）。它们进入路由清单（`sfly api --list` / `--describe` 读的就是它），
 *    以后的鉴权也在契约路由一处按它们判断一个请求要什么、作用在什么上，不靠各个接口自己记。
 *    `checkRouteDeclarations`（./declarations.ts）检查声明本身站得住，契约测试对每个接口运行它；
 *    声明为 `read` 的接口真的不写库，由控制面的测试用真实的请求核对（apps/server/test/read-only-routes.test.ts）。
 *    响应的 JSON Schema 随路由清单一起导出（`response`；SSE 是 `events`），不用另写。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 请求校验失败时的错误码与说明；不给说明时用校验失败的概要（哪个字段、什么原因）。 */
export interface RequestErrorInfo {
	code: string;
	message?: string;
}

/** 未解析的原始请求（控制面收到的 params / query / body）。 */
export interface RawRequest {
	params: unknown;
	query: unknown;
	body: unknown;
}

/**
 * 接口作用在哪一类资源上（GLOSSARY 的词）；一个接口只有一个主要的资源：它的 id、名称就是请求用来定位的那个。
 *
 * - `scenario` 场景（场景版本、运行预设、在线编辑者都属于场景：定位用场景的 id）。
 * - `run` 运行。
 * - `task` 任务：任务的日志、动作和产物用任务 id 定位，它属于某次运行。
 * - `package` 节点包（版本、节点类型、归档都属于节点包：定位用包名）。
 * - `agent` Agent。
 * - `feishu_bot` 飞书机器人。
 * - `system` 平台自身：与具体的场景、运行都无关的东西（健康检查、用户文档、SDK 与 Agent 的安装包和安装脚本、
 *   API 客户端安装包、项目设置）。
 */
export const RESOURCE_KINDS = [
	"scenario",
	"run",
	"task",
	"package",
	"agent",
	"feishu_bot",
	"system",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** 资源类别的中文名（GLOSSARY 的词），路由清单带着它给命令行显示。 */
export const RESOURCE_KIND_LABELS = {
	scenario: "场景",
	run: "运行",
	task: "任务",
	package: "节点包",
	agent: "Agent",
	feishu_bot: "飞书机器人",
	system: "系统",
} as const satisfies Record<ResourceKind, string>;

/**
 * 用请求里的哪个字段定位到具体的那一个资源：
 *
 * - `{ params: "id" }`、`{ query: "name" }`、`{ body: "name" }`：路径参数、查询参数、请求体字段的名字，值就是资源的标识
 *   （路径参数必须是路径模板里的 `:名称`，查询参数与请求体字段必须在对应的 schema 里；契约测试检查）。
 *   `/tasks/:id/logs` 的 `id` 是任务的标识，所以类别写 `task`。
 * - `"collection"`：列表，或新建一个；请求没有指向某一个已有的资源（路径里不带任何参数）。
 *   新建在别的资源名下的子资源（场景的运行预设、运行）时，定位的是那个上级资源。
 * - `"upload"`：具体的那一个在上传的内容里（发布节点包：包名与版本在归档的元信息里），请求的字段里没有。
 * - `"global"`：只用于 `system`，平台自身，没有「具体的那一个」。
 */
export type ResourceTarget =
	| { params: string }
	| { query: string }
	| { body: string }
	| "collection"
	| "upload"
	| "global";

/** 接口作用在哪类资源上，以及怎么定位到具体的那一个。 */
export interface ResourceRef {
	kind: ResourceKind;
	target: ResourceTarget;
}

/**
 * 接口对控制面状态的影响：
 *
 * - `read` 只读：不改变控制面的任何状态（库、文件、内存里的状态），也不对外发出请求；重复调用不留痕迹。
 * - `write` 有副作用：改变控制面的状态，或对外产生影响（给飞书发消息、让 Agent 更新）。
 *
 * 声明与 HTTP 方法无关：方法是 GET 不等于只读，要看它实际做了什么。
 */
export const EFFECTS = ["read", "write"] as const;
export type Effect = (typeof EFFECTS)[number];

interface RouteDefBase {
	/**
	 * Fastify 风格的路径模板，路径参数写作 `:name`，末尾的 `*` 匹配剩余路径（参数名为 `*`）；
	 * 不含浏览器侧的 `/api` 前缀。
	 */
	path: string;
	/**
	 * 一句话说明这个接口做什么（路由清单与 `sfly api --list` / `--describe` 显示它）：写给调用方，
	 * 说它做什么、作用在什么上，不重复方法和路径。必填，没有默认值。
	 */
	summary: string;
	/** 只读还是有副作用（{@link Effect}）。必填，没有默认值。 */
	effect: Effect;
	/** 作用在哪类资源上、怎么定位到具体的那一个（{@link ResourceRef}）。必填，没有默认值。 */
	resource: ResourceRef;
	/**
	 * 是否进入 API 客户端（`@sfly/client`，ADR 0022）：开放给自建页面的接口为 true；
	 * 给 Agent、安装脚本、控制台自己用的接口和上传接口为 false（上传接口标 true 时生成失败）。
	 */
	client: boolean;
	params?: z.ZodType;
	query?: z.ZodType;
	/**
	 * 请求不符合契约时用更具体的错误码（默认 400 `invalid_request`）；返回 undefined 用默认值。
	 * details 总是 zod issues。
	 */
	requestError?: (request: RawRequest) => RequestErrorInfo | undefined;
	/**
	 * 给 curl 等非浏览器客户端的原文与下载（用户文档原文、install.sh、Agent 二进制、sfly 简单索引）：
	 * 浏览器导航到这个路径时也直接返回它，不回退到前端入口页（apps/server/src/http/web-app.ts）。
	 */
	raw?: true;
}

/** JSON 接口。 */
export interface EndpointDef extends RouteDefBase {
	method: HttpMethod;
	/** query key 前缀，第一段是领域名。 */
	key: readonly string[];
	body?: z.ZodType;
	/** 请求体是原始字节的上传（不定义 body）：路由清单里种类写 `upload`，`sfly api` 不能直接调用。 */
	upload?: true;
	response: z.ZodType;
}

/** SSE 推送（GET）：每条消息都有事件名，data 是 JSON。 */
export interface StreamDef extends RouteDefBase {
	method: "GET";
	kind: "stream";
	/** 事件名 → data 的 schema（与响应一样只描述形状，不做转换）。 */
	events: Record<string, z.ZodType>;
}

/** 返回字节流的下载（GET）；错误时仍是 JSON 的 ApiErrorBody。 */
export interface DownloadDef extends RouteDefBase {
	method: "GET";
	kind: "download";
	/** 成功时响应的 content-type。 */
	contentType: string;
}

export type RouteDef = EndpointDef | StreamDef | DownloadDef;

/** 定义一个接口（只做类型推断，原样返回）。 */
export const endpoint = <const E extends EndpointDef>(def: E): E => def;

/** 定义一个 SSE 推送。 */
export const stream = <const S extends Omit<StreamDef, "method" | "kind">>(
	def: S,
): S & { method: "GET"; kind: "stream" } => ({ ...def, method: "GET", kind: "stream" });

/** 定义一个下载。 */
export const download = <const D extends Omit<DownloadDef, "method" | "kind">>(
	def: D,
): D & { method: "GET"; kind: "download" } => ({ ...def, method: "GET", kind: "download" });

/** SSE 推送的事件：事件名 → data 的类型。 */
export type StreamEvents<S extends StreamDef> = {
	[K in keyof S["events"] & string]: z.output<S["events"][K]>;
};

type Part<E, K extends "params" | "query" | "body", IO extends "in" | "out"> = E extends {
	[P in K]: infer S extends z.ZodType;
}
	? IO extends "in"
		? z.input<S>
		: z.output<S>
	: undefined;

/** 调用方传入的请求（解析前）：没有定义的部分不需要传。 */
export type EndpointInput<E extends RouteDef> = OmitUndefined<{
	params: Part<E, "params", "in">;
	query: Part<E, "query", "in">;
	body: Part<E, "body", "in">;
}>;

/** 控制面拿到的请求（解析后）。 */
export type EndpointRequest<E extends RouteDef> = {
	params: Part<E, "params", "out">;
	query: Part<E, "query", "out">;
	body: Part<E, "body", "out">;
};

/** 响应类型；响应 schema 不做转换（约定 3），输入输出相同。 */
export type EndpointResponse<E extends EndpointDef> = z.output<E["response"]>;

type OmitUndefined<T> = { [K in keyof T as T[K] extends undefined ? never : K]: T[K] };

/** 统一的错误响应 `{ error: { code, message, details? } }`。 */
export const ApiErrorBody = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** 时间：ISO 8601 字符串（控制面用 `Date#toISOString()` 输出）。 */
export const Timestamp = z.iso.datetime();

/**
 * 控制面时间（GLOSSARY「时间」，ADR 0018）：控制面把自己的当前时间带给页面，页面据此修正浏览器时间，
 * "已运行"等时长才不依赖浏览器时钟（apps/web/src/lib/control-plane-time.ts）。
 *
 * - 每个 HTTP 响应都带 {@link CONTROL_PLANE_TIME_HEADER} 响应头，值是 `Timestamp`。
 * - 每条 SSE 流在连上时和每次心跳都发一条 {@link CONTROL_PLANE_TIME_EVENT} 事件，data 是 {@link ControlPlaneTimeEvent}。
 *   它由控制面统一发送，不写进各个 `stream` 的 `events`。
 */
export const CONTROL_PLANE_TIME_HEADER = "x-sfly-time";
export const CONTROL_PLANE_TIME_EVENT = "time";
export const ControlPlaneTimeEvent = z.object({ time: Timestamp });
export type ControlPlaneTimeEvent = z.infer<typeof ControlPlaneTimeEvent>;

/**
 * 控制面版本：每个 HTTP 响应（含错误响应和 SSE 流）都带 {@link CONTROL_PLANE_VERSION_HEADER} 响应头，
 * 值是控制面的版本号（Agent、SDK 与控制面同版本，ADR 0010）。`sfly` 命令行据此在版本不一致时告警。
 */
export const CONTROL_PLANE_VERSION_HEADER = "x-sfly-version";

/**
 * 昵称请求头（ADR 0004：只用于显示，不做鉴权）。值按 encodeURIComponent 编码，这样中文昵称也能放进请求头。
 * 写操作必须带它，没有时控制面回复 400 `nickname_required`。
 */
export const NICKNAME_HEADER = "x-sfly-nickname";

/**
 * 客户端标识请求头：API 客户端是 `sfly-client/<版本>`，命令行是 `sfly-cli/<版本>`，命令行检测到自己运行在
 * AI 编程助手里时再追加 ` agent/<AI 编程助手名称>`。和昵称一样不做校验，只用于标注。
 */
export const CLIENT_HEADER = "x-sfly-client";

/** 领域前缀（query key 的第一段）：让这个领域的查询全部失效时用，例如 `domainKey(runsApi.get)` → `["runs"]`。 */
export const domainKey = (def: EndpointDef) => [def.key[0] as string] as const;

/** 接口的 query key：`[...key, { params?, query? }]`，同一请求总是得到相同的 key。 */
export function queryKey<E extends EndpointDef>(def: E, input?: EndpointInput<E>) {
	const { params, query } = (input ?? {}) as { params?: unknown; query?: unknown };
	const vars = {
		...(params === undefined ? {} : { params }),
		...(query === undefined ? {} : { query }),
	};
	return [...def.key, vars] as const;
}
