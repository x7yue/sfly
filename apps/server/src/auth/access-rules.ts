// 访问检查要用的、只和契约有关的规则（ADR 0029「项目从请求的哪里来」「一处检查」）：
// 一个接口的项目从哪里得出，以及 Agent 凭据和任务凭据各自能调用的接口清单。不依赖 Fastify，也不碰数据库。
import { pathParamNames, type RouteDef } from "@sfly/schema";

/**
 * 一个接口的项目怎么得出（ADR 0029 把现有接口分成四类）：
 *
 * - `none`：不属于项目（`system`：健康检查、文档、SDK 与 Agent 二进制、安装脚本、API 客户端安装包、Python 索引），不需要凭据；
 * - `path`：路径带项目（列表与新建，以及按名字定位的 Agent、节点包、飞书机器人）：取路径里的 `:project`。
 *   #488 把这些接口的路径改成 `/projects/:project/…` 之前，路径里没有项目，`param` 是 null，项目就是默认项目；
 * - `scenario`、`run`、`task`：经场景、运行或任务（按 ID 定位，路径里不带项目）：项目是那个资源所在的项目
 *   （任务经它所属的运行）。`param` 是路径里 ID 的参数名。
 */
export type ProjectLocator =
	| { from: "none" }
	| { from: "path"; param: string | null }
	| { from: "scenario" | "run" | "task"; param: string };

/** 路径里用来写项目的参数名（#488：`/projects/:project/…`）。 */
export const PROJECT_PARAM = "project";

/** 接口的项目怎么得出；认不出时返回 undefined（`checkAccessRules` 在启动时拒绝，访问检查不会走到这里）。 */
export function locatorOf(def: Pick<RouteDef, "path" | "resource">): ProjectLocator | undefined {
	const { kind, target } = def.resource;
	if (kind === "system") return { from: "none" };
	if (pathParamNames(def.path).includes(PROJECT_PARAM))
		return { from: "path", param: PROJECT_PARAM };
	if (target === "collection" || target === "upload") return { from: "path", param: null };
	if (typeof target === "object" && "params" in target) {
		if (kind === "agent" || kind === "package" || kind === "feishu_bot") {
			return { from: "path", param: null };
		}
		if (kind === "scenario" || kind === "run" || kind === "task") {
			return { from: kind, param: target.params };
		}
	}
	return undefined;
}

/** `方法 路径模板`，清单和检查用它认接口。 */
export const routeKey = (def: Pick<RouteDef, "method" | "path">): string =>
	`${def.method} ${def.path}`;

/**
 * Agent 凭据和任务凭据不走范围表：它们不是人也不是程序，各有一份显式的接口清单，清单之外一律拒绝（403）
 * （ADR 0029「一处检查」）。值说明这个接口上还要核对什么：
 *
 * - `package_archive`：下载节点包归档，包要在这台 Agent 所属的项目或公共项目里；
 * - `assigned_task`：上传产物，任务要是派给这台 Agent 的（任务名和 Agent 的名字相同，且在同一个项目里）；
 * - `project_task`：下载产物，任务要在凭据所属的项目里。
 *
 * 任务凭据在任何节点代码里都拿得到，所以它不给「任务的读」那样宽的范围（那会包括全项目每个任务的日志和动作）。
 * 项目的写法见 {@link locatorOf}：这些接口的项目都经过同样的得出方式，#488 改路径时清单的键跟着改（测试检查清单里的接口都在契约里）。
 */
export const AGENT_CREDENTIAL_ROUTES = {
	"GET /packages/:name/versions/:version/archive": "package_archive",
	"PUT /tasks/:id/artifacts/*": "assigned_task",
} as const satisfies Record<string, "package_archive" | "assigned_task">;

export const TASK_CREDENTIAL_ROUTES = {
	"GET /tasks/:id/artifacts/*": "project_task",
} as const satisfies Record<string, "project_task">;

/** 访问检查要求的契约性质，启动时检查（`guardHttpContract`）：每个接口的项目都认得出来。返回问题列表，空表示没有问题。 */
export function checkAccessRules(contract: readonly RouteDef[]): string[] {
	return contract.flatMap((def) => {
		// 没有写 resource 的接口由声明检查（checkRouteDeclarations）报，这里不重复。
		if (def.resource === undefined) return [];
		const problems: string[] = [];
		if (locatorOf(def) === undefined) {
			problems.push(
				`${routeKey(def)}：认不出项目从哪里得出（${def.resource.kind} × ${JSON.stringify(def.resource.target)}）：` +
					"新的资源类别或定位方式要在 locatorOf（src/auth/access-rules.ts）里写明",
			);
		}
		if (def.resource.kind === "system" && def.effect !== "read") {
			problems.push(
				`${routeKey(def)}：不属于项目的接口（system）不需要凭据，只能是只读的；有副作用的接口要作用在某类资源上，走范围表`,
			);
		}
		return problems;
	});
}

/** 两份凭据清单里的接口都在（完整的）契约里：接口改名或删掉了，清单要一起改。契约测试对 `httpContract` 运行它。 */
export function checkCredentialRoutes(contract: readonly RouteDef[]): string[] {
	const known = new Set(contract.map(routeKey));
	return [
		["AGENT_CREDENTIAL_ROUTES", AGENT_CREDENTIAL_ROUTES],
		["TASK_CREDENTIAL_ROUTES", TASK_CREDENTIAL_ROUTES],
	].flatMap(([name, list]) =>
		Object.keys(list as object)
			.filter((key) => !known.has(key))
			.map((key) => `${name} 的 ${key} 不在契约里：接口改名或删掉了，把清单一起改掉`),
	);
}
