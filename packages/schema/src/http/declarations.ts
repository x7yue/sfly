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
 * 再加三条守着下游的前提：GET 一定是只读，DELETE 一定声明 `removes`，非 GET 的只读接口一定登记在
 * {@link READS_WITH_TRACES}。
 * 契约测试对 `httpContract` 运行它；路由清单导出时也运行它，有问题就不导出。
 */

/**
 * 声明为只读、但调用后会留下点什么的接口：只写不影响任何资源内容的东西（心跳、访问日志、最后访问时间），
 * 算只读，要在这里登记，写明写了什么。方法不是 GET 的只读接口（不是一眼看得出只读的）也一定在这里。
 * 键是 `方法 路径`（路径模板）。契约测试检查表里的接口都存在、都声明为只读；
 * 控制面的测试（read-only-routes.test.ts）对这里的接口同样要求库里和数据目录里没有变化，
 * 所以只写内存的才能登记；写库的（访问日志）要先在那个测试里单独说明。
 */
export const READS_WITH_TRACES: Readonly<Record<string, string>> = {
	"POST /orchestrations/:id/presence":
		"心跳：只改内存里的在线编辑者名单（不落库），不影响场景的内容",
	"POST /orchestrations/:id/presence/leave": "离开：只从内存里的在线编辑者名单里去掉这个会话",
};

/** 说明的长度上限：它是一句话，在 `sfly api --list` 的一行里显示。 */
export const SUMMARY_MAX_LENGTH = 80;

const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** 路径模板里的参数名（不含末尾的 `*`）。 */
export function pathParamNames(path: string): string[] {
	return [...path.matchAll(PATH_PARAM)].map((found) => found[1] as string);
}

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

const label = (def: Pick<RouteDef, "method" | "path">) => `${def.method} ${def.path}`;

function checkTarget(def: RouteDef, kind: ResourceKind, target: ResourceTarget): string[] {
	const problems: string[] = [];
	const hasPathParams = pathParamNames(def.path).length > 0 || def.path.endsWith("*");
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
		if (kind === "system" && target !== "global") {
			problems.push("system 没有具体的那一个，resource.target 写 global");
		}
		return problems;
	}
	if (kind === "system") problems.push("system 没有具体的那一个，resource.target 写 global");
	if ("params" in target) {
		if (!pathParamNames(def.path).includes(target.params)) {
			problems.push(`resource.target 的路径参数 ${target.params} 不在路径 ${def.path} 里`);
		}
		return problems;
	}
	if (!("query" in target) && !("body" in target)) {
		problems.push(
			"resource.target 要写 { params }、{ query }、{ body }、collection、upload 或 global",
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
function checkEffect(def: RouteDef): string[] {
	const problems: string[] = [];
	const key = `${def.method} ${def.path}`;
	const creates: unknown = def.creates;
	const removes: unknown = def.removes;
	if (def.method === "GET" && def.effect !== "read") {
		problems.push(
			"GET 要声明为只读（effect: read）：有副作用的接口用别的方法，下游按「所有 GET 都没有副作用」判断",
		);
	}
	if (def.method !== "GET" && def.effect === "read" && !(key in READS_WITH_TRACES)) {
		problems.push(
			"方法不是 GET 的只读接口要登记在 READS_WITH_TRACES（./declarations.ts），写明它为什么是只读；没有登记的写接口应声明 effect: write",
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

/** 检查一组接口的声明；返回问题列表（每条以 `方法 路径` 开头），空表示全部站得住。 */
export function checkRouteDeclarations(contract: readonly RouteDef[]): string[] {
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
		for (const problem of checkEffect(def)) add(def, problem);

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
	}
	return problems;
}
