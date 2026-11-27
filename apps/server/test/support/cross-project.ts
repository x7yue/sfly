// 「项目甲的凭据请求项目乙的资源，每个接口一条」的生成器（ADR 0029「一处检查」最后一条，规格 #489）。
// 从契约（路由清单）生成：新加的接口自动进来；新接口是写接口、又没有请求样本时测试失败，要在这里补一个，不会悄悄没人测。
// 每加一种凭据，在测试里的凭据清单里登记一次（login、个人令牌、项目令牌…；会话令牌在 #495，等）。
import { httpContract, type ResourceKind, type RouteDef } from "@sfly/schema";
import {
	AGENT_CREDENTIAL_ROUTES,
	locatorOf,
	routeKey,
	TASK_CREDENTIAL_ROUTES,
} from "../../src/auth/access-rules.js";
import { packageArchive, packageMetadata } from "./package-archive.js";

/** 要生成测试的接口：不属于项目的（系统自身，不需要凭据；账号类接口，不属于任何项目）不在其中。 */
export const projectRoutes = (contract: readonly RouteDef[] = httpContract): RouteDef[] =>
	contract.filter((def) => {
		const from = locatorOf(def)?.from;
		return from !== "none" && from !== "account";
	});

/** 不属于项目的接口：任何凭据（含失效的）都不影响它们。 */
export const systemRoutes = (contract: readonly RouteDef[] = httpContract): RouteDef[] =>
	contract.filter((def) => locatorOf(def)?.from === "none");

/** 项目乙（被访问的）里真实存在的资源：请求的路径参数填它们。 */
export interface Victim {
	scenario: string;
	run: string;
	task: string;
	/** 项目乙里的会话：按会话 ID 定位的接口（项目从会话得出）填它。 */
	session: string;
	preset: string;
	agent: string;
	pkg: string;
	bot: string;
	/** 项目乙的标识：路径里写项目时（`/projects/:project/…`）填它。 */
	project: string;
	/** 项目乙里一个项目令牌的 ID：项目令牌的接口（`/projects/:project/tokens/:id`）填它。 */
	token: string;
	/** 项目乙里 `agent` 这台 Agent 的一个 Agent 凭据的 ID：Agent 凭据的接口（`/projects/:project/agents/:name/credentials/:id`）填它。 */
	credential: string;
}

const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)|\*$/g;

/**
 * 路径参数 `:id` 在每类资源上指什么：定位用 ID 的类别填项目乙里真实存在的那一个；这一类的接口不用 `:id` 的写 null。
 * 写成 `Record<ResourceKind, …>`：契约里加一个资源类别，这里不加一行就过不了类型检查，不会让它悄悄落进场景的 ID
 * （跨项目的测试看着通过，请求打的却不是那类资源，#554）。
 */
export const ID_PARAM_VALUES = {
	scenario: (v) => v.scenario,
	run: (v) => v.run,
	task: (v) => v.task,
	session: (v) => v.session,
	project: (v) => v.token,
	package: () => null,
	agent: (v) => v.credential,
	dev_agent: () => null,
	feishu_bot: () => null,
	system: () => null,
	account: () => null,
} as const satisfies Record<ResourceKind, (victim: Victim) => string | null>;

/** 路径参数 `:name` 在每类资源上指什么：按名字定位的类别填项目乙里的那一个，其余写 null。同样对资源类别穷举。 */
export const NAME_PARAM_VALUES = {
	scenario: () => null,
	run: () => null,
	task: () => null,
	session: () => null,
	project: () => null,
	package: (v) => v.pkg,
	agent: (v) => v.agent,
	dev_agent: (v) => v.agent,
	feishu_bot: (v) => v.bot,
	system: () => null,
	account: () => null,
} as const satisfies Record<ResourceKind, (victim: Victim) => string | null>;

function paramValue(def: RouteDef, name: string, victim: Victim): string {
	const kind = def.resource.kind;
	const required = (value: string | null): string => {
		if (value === null) {
			throw new Error(
				`${routeKey(def)}：路径参数 :${name} 在 ${kind} 上没有取值办法：在 test/support/cross-project.ts 的 ID_PARAM_VALUES、NAME_PARAM_VALUES 里补上`,
			);
		}
		return value;
	};
	switch (name) {
		case "id":
			return required(ID_PARAM_VALUES[kind](victim));
		case "name":
			return required(NAME_PARAM_VALUES[kind](victim));
		case "project":
			return victim.project;
		case "presetId":
			return victim.preset;
		case "version":
			return "1.0.0";
		case "number":
			return "1";
		case "node":
			return "echo";
		case "*":
			return "a.txt";
		default:
			return "x";
	}
}

/** 请求体样本：每个有请求体的写接口一个，写成能通过契约校验的样子（测试检查）。上传是原始字节。 */
const JSON_BODIES: Record<string, unknown> = {
	"POST /orchestrations": { name: "新场景" },
	"POST /orchestrations/:id/versions": {
		base_version: 1,
		document: { nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} },
	},
	"PATCH /orchestrations/:id": { name: "改名" },
	"POST /orchestrations/:id/copy": { name: "副本" },
	"POST /orchestrations/:id/presets": { name: "新预设", params: [{ name: "host", value: "h" }] },
	"PATCH /orchestrations/:id/presets/:presetId": { name: "预设改名" },
	"POST /orchestrations/:id/presets/:presetId/copy": { name: "预设副本" },
	"POST /orchestrations/:id/runs": { params: { host: "h" } },
	// 检查场景文档（#424）：方法不是 GET 的只读接口，同样要求项目乙的资源对项目甲不可见
	"POST /orchestrations/:id/check": {
		document: { nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} },
	},
	// 局部编辑（#470）：保存和只检查
	"POST /orchestrations/:id/edits": {
		base_version: 1,
		operations: [{ op: "set", node: "entry", field: "display_name", value: "开始" }],
	},
	"POST /orchestrations/:id/edits/check": {
		operations: [{ op: "set", node: "entry", field: "display_name", value: "开始" }],
	},
	"POST /feishu-bots": { name: "bot-new", webhook_url: "http://127.0.0.1:9/new" },
	"PATCH /feishu-bots/:name": { webhook_url: "http://127.0.0.1:9/changed" },
	"POST /projects/:project/tokens": { name: "新令牌", scopes: ["read"] },
	"POST /orchestrations/:id/presence": { session_id: "s1" },
	"POST /orchestrations/:id/presence/leave": { session_id: "s1" },
	"POST /projects/:project/sessions": { text: "你好" },
	"POST /projects/:project/dev-agents": { host: "laptop" },
	// 登记项目的工作台（#549）：项目甲的凭据对项目乙的这个接口，和别的项目的管理面一样是 404（不透露有没有这个项目）。
	"PUT /projects/:project/workbench": { agent: "workbench" },
	"POST /sessions/:id/messages": { text: "你好" },
};

/** 没有请求体的写接口。 */
const NO_BODY = new Set([
	"POST /orchestrations/:id/versions/:number/restore",
	"POST /orchestrations/:id/archive",
	"POST /orchestrations/:id/unarchive",
	"DELETE /orchestrations/:id/presets/:presetId",
	"POST /runs/:id/cancel",
	"POST /projects/:project/agents/:name/update-now",
	"DELETE /feishu-bots/:name",
	"POST /feishu-bots/:name/test",
	"DELETE /projects/:project/tokens/:id",
	"POST /projects/:project/agents/:name/credentials",
	"DELETE /projects/:project/agents/:name/credentials/:id",
	"POST /projects/:project/agents/:name/disable",
	"POST /projects/:project/agents/:name/enable",
	"DELETE /projects/:project/dev-agents/:name",
	"POST /sessions/:id/stop",
	"POST /sessions/:id/end",
]);

/** 上传：请求体是原始字节。 */
const UPLOAD_BODIES: Record<string, () => Uint8Array<ArrayBuffer>> = {
	"POST /projects/:project/packages": () =>
		packageArchive(
			packageMetadata({ name: "uploaded", version: "9.9.9" }),
		) as Uint8Array<ArrayBuffer>,
	"PUT /tasks/:id/artifacts/*": () => new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>,
};

/** 一个接口的请求（方法、地址、请求体）：路径参数填项目乙的资源，写接口带样本请求体。 */
export function requestFor(
	def: RouteDef,
	victim: Victim,
): { method: string; path: string; headers: Record<string, string>; body?: RequestInit["body"] } {
	const path = def.path.replace(PATH_PARAM, (_, name: string | undefined) =>
		encodeURIComponent(paramValue(def, name ?? "*", victim)).replaceAll("%2F", "/"),
	);
	const key = routeKey(def);
	const upload = UPLOAD_BODIES[key];
	if (upload) {
		return {
			method: def.method,
			path,
			headers: { "content-type": "application/octet-stream" },
			body: upload(),
		};
	}
	const json = JSON_BODIES[key];
	if (json !== undefined) {
		return {
			method: def.method,
			path,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(json),
		};
	}
	if (def.method !== "GET" && !NO_BODY.has(key)) {
		throw new Error(
			`${key} 是新的有请求体的接口：在 test/support/cross-project.ts 的 JSON_BODIES、UPLOAD_BODIES 或 NO_BODY 里补一个请求样本，跨项目的测试才能覆盖它`,
		);
	}
	return { method: def.method, path, headers: {} };
}

/** 项目甲的 Agent 凭据、任务凭据请求项目乙的这个接口：在清单里是 404（项目乙的资源），不在清单里是 403。 */
export const expectedForAgent = (def: RouteDef): 403 | 404 =>
	routeKey(def) in AGENT_CREDENTIAL_ROUTES ? 404 : 403;
export const expectedForTask = (def: RouteDef): 403 | 404 =>
	routeKey(def) in TASK_CREDENTIAL_ROUTES ? 404 : 403;
