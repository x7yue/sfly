// 「项目甲的凭据请求项目乙的资源，每个接口一条」的生成器（ADR 0029「一处检查」最后一条，规格 #489）。
// 从契约（路由清单）生成：新加的接口自动进来；新接口是写接口、又没有请求样本时测试失败，要在这里补一个，不会悄悄没人测。
// 每加一种凭据，在测试里的凭据清单里登记一次（login、个人令牌、项目令牌…；会话令牌在 #495，等）。
import { httpContract, type RouteDef } from "@sfly/schema";
import {
	AGENT_CREDENTIAL_ROUTES,
	locatorOf,
	routeKey,
	TASK_CREDENTIAL_ROUTES,
} from "../../src/auth/access-rules.js";
import { packageArchive, packageMetadata } from "./package-archive.js";

/** 要生成测试的接口：不属于项目的（系统自身，不需要凭据）不在其中。 */
export const projectRoutes = (contract: readonly RouteDef[] = httpContract): RouteDef[] =>
	contract.filter((def) => locatorOf(def)?.from !== "none");

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
	/** 项目乙的标识：路径里写项目时（#488）填它。 */
	project: string;
}

const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)|\*$/g;

function paramValue(def: RouteDef, name: string, victim: Victim): string {
	const kind = def.resource.kind;
	switch (name) {
		case "id":
			// 没有认出的类别不能悄悄落到场景上：那会让新类别的接口请求一个不存在的资源，测试看着通过其实什么也没测。
			switch (kind) {
				case "run":
					return victim.run;
				case "task":
					return victim.task;
				case "session":
					return victim.session;
				case "scenario":
					return victim.scenario;
				default:
					throw new Error(
						`${def.method} ${def.path}：路径参数 :id 的资源类别 ${kind} 没有样本，在 test/support/cross-project.ts 的 paramValue 里补上`,
					);
			}
		case "name":
			return kind === "agent" ? victim.agent : kind === "package" ? victim.pkg : victim.bot;
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
	"POST /orchestrations/:id/presence": { session_id: "s1" },
	"POST /orchestrations/:id/presence/leave": { session_id: "s1" },
	"POST /projects/:project/sessions": { text: "你好" },
	"POST /sessions/:id/messages": { text: "你好" },
};

/** 没有请求体的写接口。 */
const NO_BODY = new Set([
	"POST /orchestrations/:id/versions/:number/restore",
	"POST /orchestrations/:id/archive",
	"POST /orchestrations/:id/unarchive",
	"DELETE /orchestrations/:id/presets/:presetId",
	"POST /runs/:id/cancel",
	"POST /agents/:name/update-now",
	"DELETE /feishu-bots/:name",
	"POST /feishu-bots/:name/test",
	"POST /sessions/:id/stop",
]);

/** 上传：请求体是原始字节。 */
const UPLOAD_BODIES: Record<string, () => Uint8Array<ArrayBuffer>> = {
	"POST /packages": () =>
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
