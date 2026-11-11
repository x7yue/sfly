import { OrchestrationNode } from "@sfly/schema";
import { type DocumentEdit, type Rejected, rejected } from "./edit-result.js";
import type { Position } from "./layout.js";
import { uniqueNodeId } from "./node-id.js";

/**
 * 单个节点的复制、粘贴、创建副本（画布的 Ctrl+C / Ctrl+V / Ctrl+D）。都是纯函数，不改动传入的文档。
 *
 * 复制的内容放在系统剪贴板里，可以粘贴到另一个场景或另一个浏览器标签页：带类型标记的 JSON，
 * 内容是节点本身（不含位置），包节点再带上来源场景锁定的节点包版本。粘贴出来的节点和副本有新的 ID、
 * 不带连线；参数原样保留（里面的引用在新位置不成立时，静态检查照常给出警告）。
 * 入口节点和子流程入口节点不能复制：入口唯一，子流程名称唯一。
 */

/** 剪贴板 JSON 的类型标记。 */
export const NODE_CLIPBOARD_TYPE = "sfly/node";

/** 不含位置的节点（按节点种类分别去掉 position）。 */
type DocNode = OrchestrationNode extends infer N
	? N extends OrchestrationNode
		? Omit<N, "position">
		: never
	: never;

/** 剪贴板里的节点。 */
export interface CopiedNode {
	/** 节点本身，不含位置。 */
	node: DocNode;
	/** 包节点：来源场景锁定的节点包版本。 */
	packageVersion?: string | undefined;
}

/** 复制、粘贴、创建副本作用的文档（只读取节点和包版本锁定；连线原样保留）。 */
export interface CopyDocument {
	nodes: readonly OrchestrationNode[];
	packages: Readonly<Record<string, string>>;
}

/** 这个节点能不能复制、创建副本；可以时返回 null。 */
export function copyProblem(node: { kind: OrchestrationNode["kind"] }): string | null {
	if (node.kind === "entry") return "入口节点不能复制或创建副本";
	if (node.kind === "subflow_entry") return "子流程入口节点不能复制或创建副本";
	return null;
}

/** 复制节点时写进剪贴板的文字。 */
export function copiedNodeText(
	doc: CopyDocument,
	id: string,
): { ok: true; text: string } | Rejected {
	const found = doc.nodes.find((n) => n.id === id);
	if (!found) return rejected(`节点 ${id} 不存在`);
	const problem = copyProblem(found);
	if (problem) return rejected(problem);
	const { position: _, ...node } = found;
	const version = node.kind === "package" ? doc.packages[node.package] : undefined;
	const content = {
		type: NODE_CLIPBOARD_TYPE,
		node,
		...(node.kind === "package" && version ? { package: { name: node.package, version } } : {}),
	};
	return { ok: true, text: JSON.stringify(content) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** 读剪贴板里的文字：是合法的、可以粘贴的节点时返回它，否则返回 null。 */
export function readCopiedNode(text: string): CopiedNode | null {
	let content: unknown;
	try {
		content = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(content) || content.type !== NODE_CLIPBOARD_TYPE) return null;
	const { type: _, node: raw, package: pkg, ...extra } = content;
	if (Object.keys(extra).length > 0) return null;
	const parsed = OrchestrationNode.safeParse(raw);
	if (!parsed.success || parsed.data.position !== undefined) return null;
	const { position: __, ...node } = parsed.data;
	if (copyProblem(node)) return null;
	if (pkg === undefined) return { node };
	if (
		!isRecord(pkg) ||
		Object.keys(pkg).length !== 2 ||
		node.kind !== "package" ||
		pkg.name !== node.package ||
		typeof pkg.version !== "string" ||
		pkg.version === ""
	) {
		return null;
	}
	return { node, packageVersion: pkg.version };
}

/**
 * 把复制的节点放进文档：新 ID（原 ID 去掉末尾的序号再编号），放在 position，不带连线。
 * 包节点：文档还没锁定这个节点包时带上原来的版本；已锁定别的版本时用文档的版本。
 */
export function placeCopy<D extends CopyDocument>(
	doc: D,
	copied: CopiedNode,
	position: Position,
): DocumentEdit<D, { id: string }> {
	const problem = copyProblem(copied.node);
	if (problem) return rejected(problem);
	const id = uniqueNodeId(
		copied.node.id.replace(/_\d+$/, ""),
		doc.nodes.map((n) => n.id),
	);
	const node = { ...copied.node, id, position } as OrchestrationNode;
	const pkg = node.kind === "package" ? node.package : undefined;
	const packages =
		pkg && copied.packageVersion && doc.packages[pkg] === undefined
			? { ...doc.packages, [pkg]: copied.packageVersion }
			: doc.packages;
	return { ok: true, id, doc: { ...doc, nodes: [...doc.nodes, node], packages } };
}

/** 创建副本：同一个场景里复制再粘贴到 position。 */
export function duplicateNode<D extends CopyDocument>(
	doc: D,
	id: string,
	position: Position,
): DocumentEdit<D, { id: string }> {
	const found = doc.nodes.find((n) => n.id === id);
	if (!found) return rejected(`节点 ${id} 不存在`);
	const { position: _, ...node } = found;
	return placeCopy(doc, { node }, position);
}
