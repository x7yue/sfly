import {
	type EditOperation,
	type EditOperationProblem,
	isRemovedNodeKind,
	OrchestrationNode,
	SETTABLE_NODE_FIELDS,
	type StoredNode,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { disconnectEdge, insertAfter } from "./chain-edits.js";
import { describeSchema, orderedInputs } from "./inputs.js";
import { nodeKindLabel, nodeNameWithId } from "./node-display.js";
import { uniqueNodeId } from "./node-id.js";
import { type NodeTypeIo, type PackageCatalog, packageKey } from "./references.js";
import { removeNodes } from "./remove-nodes.js";
import { checkConnection } from "./structure.js";

/**
 * 场景的局部编辑（#470）：把一组操作（@sfly/schema 的 EditOperation）按顺序作用在文档上。
 * 每个操作用的都是画布上做同一件事的函数：加节点接在后面是 insertAfter，删节点是 removeNodes，
 * 连线先过 checkConnection 再追加，断开是 disconnectEdge，新节点的 ID 是 uniqueNodeId、内容是 newPackageNode。
 * 有一个操作不合法时整组不生效：返回第几个、为什么，以及让调用方自己改对的线索（相近的节点 ID、缺的输入和类型、两端的节点）。
 * 纯函数，不改传入的文档；结果还要按场景文档的 schema 解析、按保存的规则检查（控制面做）。
 */

type Doc = StoredOrchestrationDocument;
type Node = StoredNode;

export interface EditContext {
	/** 节点包目录（`packageKey(包名, 版本)` → 节点类型；null 是没有这个版本，没有这个键是不知道，例如没有上报的开发版本）。 */
	catalog: PackageCatalog;
	/** 还没有锁定的包默认用哪个版本：最新发布的版本，没有发布过、有在线的 Agent 加载着开发版本时是 `dev`；控制面上没有这个包时 undefined。 */
	defaultVersion(packageName: string): string | undefined;
}

export type EditOutcome = { ok: true; doc: Doc } | { ok: false; problem: EditOperationProblem };

/** 画布上新加的包节点的内容（添加节点菜单选一个节点类型）。 */
export const newPackageNode = (pkg: string, node: string, id: string) => ({
	id,
	kind: "package" as const,
	package: pkg,
	node,
	always: false,
	inputs: {} as Record<string, unknown>,
});

/** 一个操作不合法：原因和线索（不带操作的序号，由 applyEditOperations 补上）。 */
type Problem = Omit<EditOperationProblem, "index" | "op">;
type Step = { ok: true; doc: Doc } | { ok: false; problem: Problem };
const fail = (message: string, extra: Omit<Problem, "message"> = {}): Step => ({
	ok: false,
	problem: { message, ...extra },
});

export function applyEditOperations(
	doc: Doc,
	operations: readonly EditOperation[],
	context: EditContext,
): EditOutcome {
	let current = doc;
	for (const [index, operation] of operations.entries()) {
		const step = applyOne(current, operation, context);
		if (!step.ok) {
			const { message, ...hints } = step.problem;
			return {
				ok: false,
				problem: {
					index,
					op: operation.op,
					message: `第 ${index + 1} 个操作（${operation.op}）：${message}`,
					...hints,
				},
			};
		}
		current = step.doc;
	}
	return { ok: true, doc: current };
}

function applyOne(doc: Doc, operation: EditOperation, context: EditContext): Step {
	switch (operation.op) {
		case "add_node":
			return addNode(doc, operation, context);
		case "remove_node":
			return removeNode(doc, operation.node);
		case "connect":
			return connect(doc, operation);
		case "disconnect":
			return disconnect(doc, operation);
		case "set":
			return setField(doc, operation, context);
	}
}

// —— 节点 ID ——

/** 两个字符串的编辑距离。 */
function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const saved = row[j] as number;
			row[j] = Math.min(
				(row[j] as number) + 1,
				(row[j - 1] as number) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = saved;
		}
	}
	return row[b.length] as number;
}

/** 比较时不看大小写和分隔符（`-`、`_`、空白）。 */
const loose = (id: string) => id.toLowerCase().replace(/[-_\s]/g, "");

/**
 * 和 `id` 相近的节点 ID（写错了一两个字、大小写或分隔符不同、只写了其中一段），最相近的在前，最多 5 个。
 */
export function similarNodeIds(id: string, ids: Iterable<string>): string[] {
	const wanted = loose(id);
	const scored = [...ids].flatMap((candidate) => {
		const other = loose(candidate);
		const d = distance(wanted, other);
		const close = d <= Math.max(2, Math.floor(wanted.length / 3));
		// 只写了其中一段：短的那个至少 3 个字、占长的一半以上（entry 不算 entry_point_check 的近似）。
		const [short, long] = wanted.length <= other.length ? [wanted, other] : [other, wanted];
		const part = short.length >= 3 && short.length * 2 >= long.length && long.includes(short);
		return close || part ? [{ candidate, d }] : [];
	});
	return scored
		.sort((a, b) => a.d - b.d || (a.candidate < b.candidate ? -1 : 1))
		.slice(0, 5)
		.map((s) => s.candidate);
}

/** 节点不存在：列出相近的 ID，没有相近的就列出场景里全部的节点（最多 30 个）。 */
function unknownNode(doc: Doc, id: string): Step {
	const ids = doc.nodes.map((n) => n.id);
	const similar = similarNodeIds(id, ids);
	if (similar.length > 0) {
		return fail(`节点 ${id} 不存在，相近的节点：${similar.join("、")}`, { similar });
	}
	const choices = ids.slice(0, 30);
	return fail(`节点 ${id} 不存在，场景里的节点：${choices.join("、")}`, { similar, choices });
}

const findNode = (doc: Doc, id: string) => doc.nodes.find((n) => n.id === id);

// —— 节点的写法 ——

const typeName = (node: Node) =>
	node.kind === "package" ? `${node.package}/${node.node}` : undefined;

/** 节点的名字，后面接正文时补的空格：「显示名称（ID）」以全角括号结尾，不用空格。 */
const named = (node: Node) => {
	const name = nodeNameWithId(node);
	return name.endsWith("）") ? name : `${name} `;
};

/** 错误信息里写一端：「名字 是 种类」，包节点带上节点类型。 */
const endText = (node: Node) => {
	const type = typeName(node);
	return `${named(node)}是${nodeKindLabel(node.kind)}${type ? ` ${type}` : ""}`;
};

const nodeRef = (node: Node) => {
	const type = typeName(node);
	return { id: node.id, kind: node.kind, ...(type && { type }) };
};

// —— 节点类型 ——

/** 节点类型的输入有什么问题：多出来的输入名、缺的必填输入（带类型）。 */
function inputsProblem(
	type: NodeTypeIo,
	label: string,
	inputs: Record<string, unknown>,
): Step | null {
	const declared = orderedInputs(type.inputs).map(([name]) => name);
	const unknown = Object.keys(inputs).find((name) => !declared.includes(name));
	if (unknown !== undefined) {
		return fail(
			`节点类型 ${label} 没有输入 ${unknown}，有：${declared.join("、") || "（没有输入）"}`,
			{
				choices: declared,
			},
		);
	}
	const missing = orderedInputs(type.inputs)
		.filter(([name]) => (type.inputs.required ?? []).includes(name) && !Object.hasOwn(inputs, name))
		.map(([name, schema]) => ({ name, type: describeSchema(schema) }));
	if (missing.length > 0) {
		const listed = missing.map((m) => `${m.name}（${m.type}）`).join("、");
		return fail(`节点类型 ${label} 缺少必填输入：${listed}`, { missing });
	}
	return null;
}

/** 包节点的节点类型：知道时返回它，不知道时（没有上报的开发版本）返回 undefined，不对时返回拒绝。 */
function nodeType(
	catalog: PackageCatalog,
	pkg: string,
	version: string,
	node: string,
): { type: NodeTypeIo | undefined } | Step {
	const types = catalog.get(packageKey(pkg, version));
	if (types === undefined) return { type: undefined };
	if (types === null) return fail(`控制面上没有节点包版本 ${pkg}@${version}`);
	const type = types.find((t) => t.name === node);
	if (type) return { type };
	const choices = types.map((t) => t.name);
	return fail(`节点包 ${pkg}@${version} 里没有节点类型 ${node}，有：${choices.join("、")}`, {
		choices,
		similar: similarNodeIds(node, choices),
	});
}

const isStep = (value: object): value is Step => "ok" in value;

// —— 操作 ——

/** 新节点的 ID：引用输出时写在 `nodes.<ID>.outputs.<输出>` 里，不能有点和空白；画布生成的 ID 也是这些字符。 */
const NODE_ID = /^[A-Za-z0-9_-]+$/;

const ADD_NODE_FIELDS = [
	"display_name",
	"note",
	"agent",
	"always",
	"timeout",
	"retries",
	"queue_timeout",
] as const;

function addNode(
	doc: Doc,
	operation: Extract<EditOperation, { op: "add_node" }>,
	context: EditContext,
): Step {
	const { package: pkg, node: nodeName } = operation;
	if (operation.id !== undefined && !NODE_ID.test(operation.id)) {
		return fail(
			`节点 ID ${JSON.stringify(operation.id)} 不能用：只能用字母、数字、下划线和连字符（输出的引用里要写它：\${{ nodes.<节点 ID>.outputs.<输出> }}）`,
		);
	}
	if (operation.id !== undefined && findNode(doc, operation.id)) {
		return fail(`节点 ID ${operation.id} 已存在`);
	}
	if (operation.after !== undefined && !findNode(doc, operation.after)) {
		return unknownNode(doc, operation.after);
	}
	const locked = doc.packages[pkg];
	if (locked !== undefined && operation.version !== undefined && operation.version !== locked) {
		return fail(
			`场景锁定的是 ${pkg}@${locked}，同一个包在一个场景里只能用一个版本；换版本用 pull / push 改 packages`,
		);
	}
	const version = locked ?? operation.version ?? context.defaultVersion(pkg);
	if (version === undefined) {
		return fail(`控制面上没有节点包 ${pkg}：没有发布过，也没有在线的 Agent 加载着它的开发版本`);
	}
	const found = nodeType(context.catalog, pkg, version, nodeName);
	if (isStep(found)) return found;
	const inputs = { ...(operation.inputs ?? {}) };
	if (found.type) {
		const problem = inputsProblem(found.type, `${pkg}/${nodeName}`, inputs);
		if (problem) return problem;
	}

	const id =
		operation.id ??
		uniqueNodeId(
			nodeName,
			doc.nodes.map((n) => n.id),
		);
	const fields = Object.fromEntries(
		ADD_NODE_FIELDS.flatMap((key) => (operation[key] === undefined ? [] : [[key, operation[key]]])),
	);
	const node = { ...newPackageNode(pkg, nodeName, id), inputs, ...fields } as Node;
	const packages = locked === undefined ? { ...doc.packages, [pkg]: version } : doc.packages;
	if (operation.after === undefined) {
		return { ok: true, doc: { ...doc, nodes: [...doc.nodes, node], packages } };
	}
	const edit = insertAfter(doc, operation.after, node);
	if (!edit.ok) {
		const after = findNode(doc, operation.after) as Node;
		return fail(`${edit.reason}（接在 ${endText(after)} 后面）`, { from: nodeRef(after) });
	}
	return { ok: true, doc: { ...edit.doc, packages } };
}

function removeNode(doc: Doc, id: string): Step {
	if (!findNode(doc, id)) return unknownNode(doc, id);
	const edit = removeNodes(doc, [id]);
	if (!edit.ok) return fail(edit.reason);
	return { ok: true, doc: edit.doc };
}

type EdgeOperation = Extract<EditOperation, { op: "connect" | "disconnect" }>;
const edgeText = (e: { from: string; to: string; kind: string }) =>
	`${e.from} → ${e.to}（${e.kind}）`;

function connect(doc: Doc, operation: EdgeOperation): Step {
	const from = findNode(doc, operation.from);
	if (!from) return unknownNode(doc, operation.from);
	const to = findNode(doc, operation.to);
	if (!to) return unknownNode(doc, operation.to);
	const edge = { from: from.id, to: to.id, kind: operation.kind };
	const problem = checkConnection(doc, edge);
	if (problem) {
		return fail(`${problem}（起点 ${endText(from)}，终点 ${endText(to)}）`, {
			from: nodeRef(from),
			to: nodeRef(to),
		});
	}
	return { ok: true, doc: { ...doc, edges: [...doc.edges, edge] } };
}

function disconnect(doc: Doc, operation: EdgeOperation): Step {
	if (!findNode(doc, operation.from)) return unknownNode(doc, operation.from);
	if (!findNode(doc, operation.to)) return unknownNode(doc, operation.to);
	const next = disconnectEdge(doc, operation);
	if (next !== doc) return { ok: true, doc: next };
	const touching = doc.edges.filter((e) => e.from === operation.from || e.to === operation.from);
	return fail(
		`没有连线 ${edgeText(operation)}；${operation.from} 的连线：${touching.map(edgeText).join("、") || "没有"}`,
	);
}

/** 每种节点能改的字段（包节点还能改 `inputs.<输入名>`）。 */
function settableFields(kind: Node["kind"]): readonly string[] {
	switch (kind) {
		case "package":
			return SETTABLE_NODE_FIELDS;
		case "subflow_entry":
			return ["note"];
		case "stop_subflow":
			return ["display_name", "note", "always"];
		default:
			return ["display_name", "note"];
	}
}

const INPUT_PREFIX = "inputs.";

function setField(
	doc: Doc,
	operation: Extract<EditOperation, { op: "set" }>,
	context: EditContext,
): Step {
	const node = findNode(doc, operation.node);
	if (!node) return unknownNode(doc, operation.node);
	if (isRemovedNodeKind(node.kind)) {
		return fail(
			`节点 ${nodeNameWithId(node)} 是${nodeKindLabel(node.kind)}，不能保存，先用 remove_node 删掉`,
		);
	}
	const { field } = operation;
	// 不写 value 是去掉这个字段；写 null 就是 null（输入可以是 null，别的字段写 null 按值不合法报错）。
	const { value } = operation;
	const input = node.kind === "package" && field.startsWith(INPUT_PREFIX);
	const allowed = settableFields(node.kind);
	if (!input && !allowed.includes(field)) {
		const listed = [...(node.kind === "package" ? ["inputs.<输入名>"] : []), ...allowed].join("、");
		const kind = nodeKindLabel(node.kind);
		const label = kind.endsWith("节点") ? kind : `${kind}节点`;
		return fail(`${label} ${named(node)}不能改字段 ${field}，能改：${listed}`, {
			choices: [...allowed],
		});
	}
	let next: Record<string, unknown>;
	if (input && node.kind === "package") {
		const name = field.slice(INPUT_PREFIX.length);
		const inputs = { ...node.inputs };
		if (value === undefined) delete inputs[name];
		else inputs[name] = value;
		const version = doc.packages[node.package];
		if (version !== undefined) {
			const type = context.catalog
				.get(packageKey(node.package, version))
				?.find((t) => t.name === node.node);
			const declared = type ? orderedInputs(type.inputs).map(([n]) => n) : undefined;
			// 节点上已经有的输入照常能改、能去掉（保存时不检查没有声明的输入）；新加的输入名要是节点类型声明了的，免得写错名字。
			if (declared && !declared.includes(name) && !Object.hasOwn(node.inputs, name)) {
				return fail(
					`节点类型 ${node.package}/${node.node} 没有输入 ${name}，有：${declared.join("、") || "（没有输入）"}`,
					{ choices: declared },
				);
			}
		}
		next = { ...node, inputs };
	} else {
		next = { ...node };
		if (value === undefined) delete next[field];
		else next[field] = value;
	}
	// 按场景文档的 schema 解析改过的节点（和保存一样去掉首尾空白、补默认值），值不合法时写明是哪个字段。
	const parsed = OrchestrationNode.safeParse(next);
	if (!parsed.success) {
		const reasons = parsed.error.issues.map((i) => i.message).join("；");
		return fail(`字段 ${field} 的值不合法：${reasons}`);
	}
	return { ok: true, doc: { ...doc, nodes: doc.nodes.map((n) => (n === node ? parsed.data : n)) } };
}
