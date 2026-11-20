import type { z } from "zod";
import {
	EFFECTS,
	RESOURCE_KINDS,
	type ResourceKind,
	type ResourceTarget,
	type RouteDef,
} from "./contract.js";

/**
 * 接口声明（约定 10：`summary`、`effect`、`resource`）的检查。类型已经保证每个接口写了这三项，
 * 这里检查写出来的值站得住：说明不是空的，资源类别在枚举里，定位的字段真的在请求里。
 * 契约测试对 `httpContract` 运行它；路由清单导出时也运行它，有问题就不导出。
 */

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
