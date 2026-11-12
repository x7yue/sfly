import type { NodeTypeMetadata, OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import { feishuReferableInputs } from "./feishu-notify.js";
import { OUTPUT_PATH, PARAM_PATH, REFERENCE } from "./reference-syntax.js";

/**
 * 引用（docs/SEMANTICS.md §2）：`${{ params.<name> }}` 和 `${{ nodes.<id>.outputs.<key> }}`。
 * 这里是静态的部分（补全、保存时的检查），控制面和画布共用；派发时的解析在 resolve.ts。
 */

/** 节点类型中用到的元信息：输入 schema 生成参数表单，输出键用于补全和引用检查。 */
export type NodeTypeIo = Pick<NodeTypeMetadata, "name" | "inputs" | "outputs">;

/**
 * 节点包目录：`packageKey(包名, 版本)` → 该版本的节点类型。
 * 值为 null 表示该版本不存在；没有这个键表示还不知道（例如前端还在加载），相关检查会跳过。
 */
export type PackageCatalog = ReadonlyMap<string, readonly NodeTypeIo[] | null>;

export const packageKey = (name: string, version: string) => `${name}@${version}`;

/** 内置节点的输出键（docs/SEMANTICS.md §4、§5）。 */
export const BUILTIN_OUTPUTS: Record<Exclude<OrchestrationNode["kind"], "package">, string[]> = {
	entry: [],
	subflow_entry: [],
	async: ["chain_instance_id"],
	timer: ["triggered_at", "late"],
	sleep: ["triggered_at"],
	stop_subflow: ["status"],
	feishu_notify: [],
};

/**
 * 包节点的节点类型：按编排锁定的版本在目录中查找。
 * null：没有锁定版本、版本不存在或版本里没有这个节点类型；undefined：目录里还没有这个版本的信息。
 */
export function nodeTypeOf(
	doc: Pick<OrchestrationDocument, "packages">,
	node: { package: string; node: string },
	catalog: PackageCatalog,
): NodeTypeIo | null | undefined {
	const version = doc.packages[node.package];
	if (version === undefined) return null;
	const types = catalog.get(packageKey(node.package, version));
	if (types === undefined) return undefined;
	return types?.find((t) => t.name === node.node) ?? null;
}

/** 节点已声明的输出键；节点类型未知时为 undefined（不能补全，也不检查）。 */
export function declaredOutputs(
	doc: OrchestrationDocument,
	node: OrchestrationNode,
	catalog: PackageCatalog,
): string[] | undefined {
	if (node.kind !== "package") return BUILTIN_OUTPUTS[node.kind];
	const type = nodeTypeOf(doc, node, catalog);
	return type ? Object.keys(type.outputs.properties) : undefined;
}

/** 一个节点能看到的引用范围：本链的入口参数，以及本链上排在它前面的节点（按链上顺序）。 */
export interface ReferenceScope {
	/** 本链的起点（入口节点或子流程入口节点）；节点不在从起点开始的链上时为 undefined。 */
	start: Extract<OrchestrationNode, { kind: "entry" | "subflow_entry" }> | undefined;
	earlier: OrchestrationNode[];
}

/** 沿链上的入线往回走到链的起点。 */
export function referenceScope(doc: OrchestrationDocument, nodeId: string): ReferenceScope {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const previous = new Map<string, string>();
	for (const edge of doc.edges) {
		if (edge.kind === "chain" && byId.has(edge.from) && !previous.has(edge.to)) {
			previous.set(edge.to, edge.from);
		}
	}
	const path: OrchestrationNode[] = [];
	const seen = new Set([nodeId]);
	const self = byId.get(nodeId);
	if (self?.kind === "entry" || self?.kind === "subflow_entry") return { start: self, earlier: [] };
	for (let id = previous.get(nodeId); id !== undefined && !seen.has(id); id = previous.get(id)) {
		seen.add(id);
		const node = byId.get(id) as OrchestrationNode;
		path.unshift(node);
		if (node.kind === "entry" || node.kind === "subflow_entry") {
			return { start: node, earlier: path };
		}
	}
	return { start: undefined, earlier: [] };
}

export interface ReferenceOption {
	/** 引用路径，例如 `params.url`、`nodes.a.outputs.body`。 */
	expression: string;
	/** 写进输入里的文本：`${{ <expression> }}`。 */
	text: string;
	kind: "param" | "output";
	/** 输出引用所属的节点。 */
	node_id?: string;
	/** 参数名或输出键。 */
	key: string;
}

export const referenceText = (expression: string) => `\${{ ${expression} }}`;

/** 引用补全：本链的入口参数，以及本链上前面节点已声明的输出键。 */
export function referenceOptions(
	doc: OrchestrationDocument,
	nodeId: string,
	catalog: PackageCatalog,
): ReferenceOption[] {
	const { start, earlier } = referenceScope(doc, nodeId);
	if (!start) return [];
	const options: ReferenceOption[] = start.params.map((p) => ({
		expression: `params.${p.name}`,
		text: referenceText(`params.${p.name}`),
		kind: "param",
		key: p.name,
	}));
	for (const node of earlier) {
		for (const key of declaredOutputs(doc, node, catalog) ?? []) {
			const expression = `nodes.${node.id}.outputs.${key}`;
			options.push({
				expression,
				text: referenceText(expression),
				kind: "output",
				node_id: node.id,
				key,
			});
		}
	}
	return options;
}

// —— 静态检查（保存时只提示警告，触发时必须全部通过） ——

export type PackageWarningCode =
	| "package_not_locked"
	| "package_version_missing"
	| "unknown_node_type";

export type ReferenceWarningCode =
	| "reference_invalid"
	| "reference_unknown_param"
	| "reference_unknown_node"
	| "reference_not_earlier"
	| "reference_unknown_output";

export type SubflowParamWarningCode = "subflow_param_unknown" | "subflow_param_missing";

export interface ReferenceWarning {
	code: PackageWarningCode | ReferenceWarningCode | SubflowParamWarningCode;
	message: string;
	node_id: string;
	/** 引用所在的输入名（包节点的输入、异步任务节点的子流程参数、Sleep 节点的 duration）。 */
	input?: string;
}

/** 值里出现的全部引用路径（递归进入对象和数组）；`${{` 没有闭合时给出 null。 */
export function referencesIn(value: unknown): (string | null)[] {
	if (typeof value === "string") {
		const paths = [...value.matchAll(REFERENCE)].map((m) => m[1] as string);
		const rest = value.replace(REFERENCE, "");
		return rest.includes("${{") ? [...paths, null] : paths;
	}
	if (Array.isArray(value)) return value.flatMap(referencesIn);
	if (value !== null && typeof value === "object")
		return Object.values(value).flatMap(referencesIn);
	return [];
}

/** 节点里可以写引用的值：输入名 → 值。 */
function referableValues(node: OrchestrationNode): [string, unknown][] {
	switch (node.kind) {
		case "package":
			return Object.entries(node.inputs);
		case "async":
			return Object.entries(node.params);
		case "sleep":
			return [["duration", node.duration]];
		case "feishu_notify":
			return [
				...(node.bot === undefined ? [] : ([["bot", node.bot]] as [string, unknown][])),
				...Object.entries(feishuReferableInputs(node)),
			];
		default:
			return [];
	}
}

/** 引用检查：引用的参数要在本链入口声明，引用的节点要在本链上当前节点之前，输出键要已声明。 */
export function referenceWarnings(
	doc: OrchestrationDocument,
	catalog: PackageCatalog,
): ReferenceWarning[] {
	const warnings: ReferenceWarning[] = [];
	const ids = new Set(doc.nodes.map((n) => n.id));
	for (const node of doc.nodes) {
		const values = referableValues(node);
		if (values.length === 0) continue;
		const { start, earlier } = referenceScope(doc, node.id);
		const params = new Set(start?.params.map((p) => p.name) ?? []);
		const earlierById = new Map(earlier.map((n) => [n.id, n]));
		for (const [input, value] of values) {
			const where = `节点 ${node.id} 的输入 ${input}`;
			const warn = (code: ReferenceWarningCode, message: string) =>
				warnings.push({ code, message, node_id: node.id, input });
			for (const path of referencesIn(value)) {
				if (path === null) {
					warn("reference_invalid", `${where} 中有没有闭合的引用 \${{`);
					continue;
				}
				const param = PARAM_PATH.exec(path);
				if (param) {
					const name = param[1] as string;
					if (!params.has(name)) {
						warn("reference_unknown_param", `${where} 引用的参数 ${name} 不是本链入口声明的参数`);
					}
					continue;
				}
				const output = OUTPUT_PATH.exec(path);
				if (!output) {
					warn(
						"reference_invalid",
						`${where} 的引用 \${{ ${path} }} 格式不对，只能写 params.<参数名> 或 nodes.<节点>.outputs.<输出键>`,
					);
					continue;
				}
				const [, target, key] = output as unknown as [string, string, string];
				const targetNode = earlierById.get(target);
				if (!ids.has(target)) {
					warn("reference_unknown_node", `${where} 引用了不存在的节点 ${target}`);
				} else if (!targetNode) {
					warn("reference_not_earlier", `${where} 引用的节点 ${target} 不在本链上它的前面`);
				} else {
					const declared = declaredOutputs(doc, targetNode, catalog);
					if (declared && !declared.includes(key)) {
						warn(
							"reference_unknown_output",
							`${where} 引用的输出键 ${key} 没有在节点 ${target} 的节点类型中声明`,
						);
					}
				}
			}
		}
	}
	return warnings;
}

/** 包版本锁定检查：每个包节点都锁定到一个存在的版本，且该版本里有这个节点类型。 */
export function packageWarnings(
	doc: OrchestrationDocument,
	catalog: PackageCatalog,
): ReferenceWarning[] {
	const warnings: ReferenceWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const version = doc.packages[node.package];
		if (version === undefined) {
			warnings.push({
				code: "package_not_locked",
				message: `节点 ${node.id} 的节点包 ${node.package} 没有锁定版本`,
				node_id: node.id,
			});
			continue;
		}
		const types = catalog.get(packageKey(node.package, version));
		if (types === null) {
			warnings.push({
				code: "package_version_missing",
				message: `节点 ${node.id} 锁定的节点包版本 ${node.package}@${version} 不存在`,
				node_id: node.id,
			});
		} else if (types && !types.some((t) => t.name === node.node)) {
			warnings.push({
				code: "unknown_node_type",
				message: `节点包 ${node.package}@${version} 中没有节点类型 ${node.node}`,
				node_id: node.id,
			});
		}
	}
	return warnings;
}

/** 异步任务节点的调度连线连到的子流程入口节点。 */
export function dispatchTarget(
	doc: OrchestrationDocument,
	asyncNodeId: string,
): Extract<OrchestrationNode, { kind: "subflow_entry" }> | undefined {
	for (const edge of doc.edges) {
		if (edge.kind !== "dispatch" || edge.from !== asyncNodeId) continue;
		const target = doc.nodes.find((n) => n.id === edge.to);
		if (target?.kind === "subflow_entry") return target;
	}
	return undefined;
}

/**
 * 参数映射检查（§4.2）：异步任务节点只能映射它触发的子流程入口声明的参数，
 * 没有默认值的必填参数必须映射。没有连到子流程入口节点时不检查（结构警告会指出）。
 */
export function subflowParamWarnings(doc: OrchestrationDocument): ReferenceWarning[] {
	const warnings: ReferenceWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "async") continue;
		const subflow = dispatchTarget(doc, node.id);
		if (!subflow) continue;
		const declared = new Set(subflow.params.map((p) => p.name));
		for (const name of Object.keys(node.params)) {
			if (declared.has(name)) continue;
			warnings.push({
				code: "subflow_param_unknown",
				message: `节点 ${node.id} 映射的参数 ${name} 不是子流程 ${subflow.id} 声明的参数`,
				node_id: node.id,
				input: name,
			});
		}
		for (const param of subflow.params) {
			if (!param.required || param.default !== undefined || Object.hasOwn(node.params, param.name))
				continue;
			warnings.push({
				code: "subflow_param_missing",
				message: `节点 ${node.id} 没有映射子流程 ${subflow.id} 的必填参数 ${param.name}`,
				node_id: node.id,
				input: param.name,
			});
		}
	}
	return warnings;
}
