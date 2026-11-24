import { checkMembers, harvestDocs } from "./client-docs.js";
import { MEMBER } from "./client-emit.js";
import type { FieldDocs, RouteDocPart } from "./field-docs.js";
import type { RouteDef } from "./http/contract.js";

/**
 * 路由清单里字段的说明：契约源码里写在字段上的注释（JSDoc），和 API 客户端生成的类型注释是同一份
 * （client-docs.ts 用 TypeScript 的类型检查器读，zod 在运行时不留注释）。
 *
 * 范围：请求的路径参数、查询参数、请求体的字段（到第三层），响应和 SSE 事件的顶层字段；
 * 更深的字段不带说明（场景文档、运行视图这样的大结构，嵌套字段太多，完整的含义看 docs/ 和契约源码）。
 * 字段上的 `.describe(…)`（zod 的说明）本来就在 JSON Schema 里，优先于注释。
 * 类型和写进 JSON Schema 的函数在 field-docs.ts（不依赖 Node）。
 */

/** 响应和事件只读到顶层字段；请求读到第三层（请求体里 `params[].keep` 这样的嵌套字段），再深的是场景文档这样的大结构。 */
const RESPONSE_DEPTH = 1;
const REQUEST_DEPTH = 3;

/** 这个 root 最多读到第几层字段。 */
const depthLimit = (root: string): number =>
	/\.(response|event:.*)$/.test(root) ? RESPONSE_DEPTH : REQUEST_DEPTH;

const rootKey = (domain: string, name: string, part: RouteDocPart) =>
	`${domain}.${name}.${typeof part === "string" ? part : `event:${part.event}`}`;

const at = (domain: string, name: string) => `[${JSON.stringify(domain)}][${JSON.stringify(name)}]`;

/** `{@link X}` 写成 `` `X` ``：说明在清单里是纯文字。 */
const plain = (doc: string) =>
	doc.replace(/\{@link\s+([^}\s|]+)[^}]*\}/g, (_, target: string) => `\`${target}\``);

/** 读出契约里每个接口各部分的字段注释。要起一个 TypeScript 程序，比较慢：只在生成清单时用。 */
export function harvestRouteDocs(apis: Record<string, Record<string, RouteDef>>): FieldDocs {
	const roots = new Map<string, string>();
	const owners = new Map<RouteDef, { domain: string; name: string }>();
	for (const [domain, table] of Object.entries(apis)) {
		for (const [name, def] of Object.entries(table)) {
			owners.set(def, { domain, name });
			const route = `(typeof C.httpApis)${at(domain, name)}`;
			for (const part of ["params", "query", "body"] as const) {
				if (part === "body" ? "body" in def && def.body : def[part]) {
					roots.set(
						rootKey(domain, name, part),
						`NonNullable<z.input<${route}[${JSON.stringify(part)}]>>`,
					);
				}
			}
			if ("response" in def) {
				roots.set(rootKey(domain, name, "response"), `z.output<${route}["response"]>`);
			}
			if ("events" in def) {
				for (const event of Object.keys(def.events)) {
					roots.set(
						rootKey(domain, name, { event }),
						`z.output<${route}["events"][${JSON.stringify(event)}]>`,
					);
				}
			}
		}
	}
	const docs = harvestDocs({
		roots,
		stopAt: new Set(),
		maxDepth: depthLimit,
	});
	const field: FieldDocs = (route, part, path) => {
		const owner = owners.get(route);
		if (!owner) return undefined;
		const text = docs.field(rootKey(owner.domain, owner.name, part), path);
		return text === undefined ? undefined : plain(text);
	};
	// 核对联合的成员：写进清单的一边认出的成员（`annotateSchema` 走遍整个 JSON Schema），只看读注释读到的层数以内的（响应、事件
	// 只读顶层，请求读到第三层：成员所在的联合在第几层，不算成员那一段），再深的读注释一边没有读，不用核对。
	field.checkMembers = (route, part, emitted) => {
		const owner = owners.get(route);
		if (!owner) return;
		const root = rootKey(owner.domain, owner.name, part);
		const limit = depthLimit(root);
		const within = [...emitted].filter(
			(member) => member.split(".").filter((segment) => !segment.startsWith(MEMBER)).length < limit,
		);
		checkMembers(
			`${route.method} ${route.path} 的${describePart(part)}`,
			docs.members(root),
			within,
		);
	};
	return field;
}

const describePart = (part: RouteDocPart): string =>
	typeof part === "string" ? ` ${part}` : `事件 ${part.event}`;
