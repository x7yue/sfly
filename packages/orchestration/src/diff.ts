import {
	ANNOTATION_DEFAULT_COLOR,
	STICKY_NOTE_DEFAULT_COLOR,
	StoredOrchestrationDocument,
} from "@sfly/schema";
import { subflowName } from "./chain-label.js";
import { stickyHeadline } from "./sticky-notes.js";

/**
 * 两份编排文档的差异：用于保存冲突时对比本地修改与最新版本、对比任意两个历史版本。
 * 只列出差异，不做合并。节点、注释框、便签按 ID 对应，连线按（起点、终点、种类）对应。
 */

/**
 * 可以参与比较的文档：已保存的编排文档或画布草稿（输入形态，省略的字段按默认值比较）。
 * 类型故意放宽，草稿编辑到一半不完全合法时也能比较。
 */
export interface DiffableDocument {
	default_agent?: string | undefined;
	nodes: readonly ({ readonly id: string; readonly kind: string } & object)[];
	edges?: readonly DiffEdge[];
	packages?: Readonly<Record<string, string>>;
	annotations?: readonly ({ readonly id: string; readonly title: string } & object)[];
	sticky_notes?: readonly ({ readonly id: string } & object)[];
}

/** 一项字段的变化；before/after 为 undefined 表示该项不存在。 */
export interface FieldChange {
	/** 例如 `default_agent`、`packages.http`、`agent`、`inputs.url`、`params.url`。 */
	path: string;
	before: unknown;
	after: unknown;
}

export interface NodeRef {
	id: string;
	kind: string;
}

export interface NodeChange extends NodeRef {
	changes: FieldChange[];
}

export interface DiffEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: string;
}

export interface AnnotationRef {
	id: string;
	title: string;
}

/** 两边都有的注释框改了什么：`title`、`note`、`nodes`（成员节点）、`subflows`（成员子流程）。 */
export interface AnnotationChange extends AnnotationRef {
	changes: FieldChange[];
}

export interface StickyNoteRef {
	id: string;
	/** 写出这张便签时用的文字：标题，没有标题时是正文的第一行（修改后的）。 */
	label: string;
}

/** 两边都有的便签改了什么：`title`、`text`、`color`（位置和大小算布局，见 `moved`）。 */
export interface StickyNoteChange extends StickyNoteRef {
	changes: FieldChange[];
}

export interface DocumentDiff {
	/** 编排级设置：默认 Agent、锁定的包版本。 */
	settings: FieldChange[];
	nodes: { added: NodeRef[]; removed: NodeRef[]; changed: NodeChange[] };
	edges: { added: DiffEdge[]; removed: DiffEdge[] };
	/** 两边都有、只是位置变了的节点 ID（布局也是版本内容）。 */
	moved: string[];
	/** 注释框（标题是修改后的）。 */
	annotations: { added: AnnotationRef[]; removed: AnnotationRef[]; changed: AnnotationChange[] };
	/** 便签；`moved` 是两边都有、只是位置或大小变了的便签 ID（和节点的 `moved` 一样算布局）。 */
	stickyNotes: {
		added: StickyNoteRef[];
		removed: StickyNoteRef[];
		changed: StickyNoteChange[];
		moved: string[];
	};
}

type Node = Record<string, unknown> & { id: string; kind: string };
type NormalAnnotation = Record<string, unknown> & AnnotationRef;
type NormalStickyNote = Record<string, unknown> & { id: string };
interface NormalDoc {
	default_agent?: unknown;
	nodes: Node[];
	edges: DiffEdge[];
	packages: Record<string, unknown>;
	annotations: NormalAnnotation[];
	sticky_notes: NormalStickyNote[];
}

/** 没有名称字段的旧版本子流程入口以节点 ID 作为名称（ADR 0016），按显示的名称比较。 */
const withSubflowName = (node: Node): Node =>
	node.kind === "subflow_entry" && node.name === undefined
		? { ...node, name: subflowName(node) }
		: node;

/** 注释框不写颜色就是灰色（ADR 0025）：写了 gray 和不写按同一种比较。 */
const withDefaultColor = (a: NormalAnnotation): NormalAnnotation =>
	a.color === ANNOTATION_DEFAULT_COLOR ? { ...a, color: undefined } : a;

/** 便签不写颜色就是黄色（ADR 0026）：写了 yellow 和不写按同一种比较。 */
const withDefaultStickyColor = (s: NormalStickyNote): NormalStickyNote =>
	s.color === STICKY_NOTE_DEFAULT_COLOR ? { ...s, color: undefined } : s;

/** 补齐默认值；文档不完全合法（例如编辑到一半的草稿）时按原样比较。 */
function normalize(doc: DiffableDocument): NormalDoc {
	const parsed = StoredOrchestrationDocument.safeParse(doc);
	const d = (parsed.success ? parsed.data : doc) as Partial<NormalDoc>;
	return {
		default_agent: d.default_agent,
		nodes: (d.nodes ?? []).map(withSubflowName),
		edges: [...(d.edges ?? [])],
		packages: d.packages ?? {},
		annotations: (d.annotations ?? []).map(withDefaultColor),
		sticky_notes: (d.sticky_notes ?? []).map(withDefaultStickyColor),
	};
}

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
	const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
	if (ka.length !== kb.length) return false;
	return ka.every((k) =>
		equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

/** 按键比较两个记录，键的顺序：先 before 中的，再 after 新增的。 */
function recordChanges(
	prefix: string,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): FieldChange[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return keys
		.filter((k) => !equal(before[k], after[k]))
		.map((k) => ({ path: `${prefix}${k}`, before: before[k], after: after[k] }));
}

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** 入口 / 子流程入口的参数声明数组按参数名对应。 */
const paramsByName = (value: unknown): Record<string, unknown> =>
	Array.isArray(value)
		? Object.fromEntries(
				value.map((p, i) => [typeof p?.name === "string" ? p.name : `#${i}`, p] as const),
			)
		: {};

/** 字段顺序：先 before 节点中的字段，再 after 新增的字段。 */
function nodeChanges(before: Node, after: Node): FieldChange[] {
	const changes: FieldChange[] = [];
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
		(k) => k !== "id" && k !== "position",
	);
	for (const key of keys) {
		const [b, a] = [before[key], after[key]];
		if (equal(b, a)) continue;
		if (key === "inputs" || (key === "params" && !Array.isArray(b) && !Array.isArray(a))) {
			// 包节点的输入、异步任务节点的子流程参数映射：逐项列出。
			changes.push(...recordChanges(`${key}.`, asRecord(b), asRecord(a)));
		} else if (key === "params") {
			changes.push(...recordChanges("params.", paramsByName(b), paramsByName(a)));
		} else {
			changes.push({ path: key, before: b, after: a });
		}
	}
	return changes;
}

/** 注释框的字段：标题、备注、颜色、成员，按 before 中的顺序，再接 after 新增的。 */
function annotationChanges(before: NormalAnnotation, after: NormalAnnotation): FieldChange[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
		(k) => k !== "id",
	);
	return keys
		.filter((k) => !equal(before[k], after[k]))
		.map((k) => ({ path: k, before: before[k], after: after[k] }));
}

const annotationRef = (a: NormalAnnotation): AnnotationRef => ({ id: a.id, title: a.title });

function diffAnnotations(before: NormalAnnotation[], after: NormalAnnotation[]) {
	const beforeById = new Map(before.map((a) => [a.id, a]));
	const afterById = new Map(after.map((a) => [a.id, a]));
	const changed: AnnotationChange[] = [];
	for (const a of before) {
		const other = afterById.get(a.id);
		const changes = other ? annotationChanges(a, other) : [];
		if (other && changes.length > 0) changed.push({ ...annotationRef(other), changes });
	}
	return {
		added: after.filter((a) => !beforeById.has(a.id)).map(annotationRef),
		removed: before.filter((a) => !afterById.has(a.id)).map(annotationRef),
		changed,
	};
}

/** 便签的写法：和画布上同一个名字（stickyHeadline），都是空白时写 ID。草稿里的字段可能不是字符串。 */
const stickyRef = (s: NormalStickyNote): StickyNoteRef => {
	const title = typeof s.title === "string" ? s.title : undefined;
	const text = typeof s.text === "string" ? s.text : "";
	return { id: s.id, label: stickyHeadline({ title, text }) || s.id };
};

const STICKY_LAYOUT_FIELDS = new Set(["position", "size"]);

function diffStickyNotes(before: NormalStickyNote[], after: NormalStickyNote[]) {
	const beforeById = new Map(before.map((s) => [s.id, s]));
	const afterById = new Map(after.map((s) => [s.id, s]));
	const changed: StickyNoteChange[] = [];
	const moved: string[] = [];
	for (const s of before) {
		const other = afterById.get(s.id);
		if (!other) continue;
		const keys = [...new Set([...Object.keys(s), ...Object.keys(other)])].filter(
			(k) => k !== "id" && !equal(s[k], other[k]),
		);
		const changes = keys
			.filter((k) => !STICKY_LAYOUT_FIELDS.has(k))
			.map((k) => ({ path: k, before: s[k], after: other[k] }));
		if (changes.length > 0) changed.push({ ...stickyRef(other), changes });
		if (keys.some((k) => STICKY_LAYOUT_FIELDS.has(k))) moved.push(s.id);
	}
	return {
		added: after.filter((s) => !beforeById.has(s.id)).map(stickyRef),
		removed: before.filter((s) => !afterById.has(s.id)).map(stickyRef),
		changed,
		moved,
	};
}

const edgeKey = (e: DiffEdge) => `${e.kind}:${e.from}->${e.to}`;
const nodeRef = (n: Node): NodeRef => ({ id: n.id, kind: n.kind });

export function diffDocuments(before: DiffableDocument, after: DiffableDocument): DocumentDiff {
	const b = normalize(before);
	const a = normalize(after);

	const settings = [
		...(equal(b.default_agent, a.default_agent)
			? []
			: [{ path: "default_agent", before: b.default_agent, after: a.default_agent }]),
		...recordChanges("packages.", b.packages, a.packages),
	];

	const beforeNodes = new Map(b.nodes.map((n) => [n.id, n]));
	const afterNodes = new Map(a.nodes.map((n) => [n.id, n]));
	const changed: NodeChange[] = [];
	const moved: string[] = [];
	for (const node of b.nodes) {
		const other = afterNodes.get(node.id);
		if (!other) continue;
		const changes = nodeChanges(node, other);
		if (changes.length > 0) changed.push({ id: node.id, kind: other.kind, changes });
		if (!equal(node.position, other.position)) moved.push(node.id);
	}

	const beforeEdges = new Set(b.edges.map(edgeKey));
	const afterEdges = new Set(a.edges.map(edgeKey));
	const plainEdge = (e: DiffEdge): DiffEdge => ({ from: e.from, to: e.to, kind: e.kind });

	return {
		settings,
		nodes: {
			added: a.nodes.filter((n) => !beforeNodes.has(n.id)).map(nodeRef),
			removed: b.nodes.filter((n) => !afterNodes.has(n.id)).map(nodeRef),
			changed,
		},
		edges: {
			added: a.edges.filter((e) => !beforeEdges.has(edgeKey(e))).map(plainEdge),
			removed: b.edges.filter((e) => !afterEdges.has(edgeKey(e))).map(plainEdge),
		},
		moved,
		annotations: diffAnnotations(b.annotations, a.annotations),
		stickyNotes: diffStickyNotes(b.sticky_notes, a.sticky_notes),
	};
}

/** 没有任何差异；ignoreLayout 时忽略只移动了位置的节点和只移动了位置、改了大小的便签。 */
export function isEmptyDiff(diff: DocumentDiff, options: { ignoreLayout?: boolean } = {}): boolean {
	return (
		diff.settings.length === 0 &&
		diff.nodes.added.length === 0 &&
		diff.nodes.removed.length === 0 &&
		diff.nodes.changed.length === 0 &&
		diff.edges.added.length === 0 &&
		diff.edges.removed.length === 0 &&
		diff.annotations.added.length === 0 &&
		diff.annotations.removed.length === 0 &&
		diff.annotations.changed.length === 0 &&
		diff.stickyNotes.added.length === 0 &&
		diff.stickyNotes.removed.length === 0 &&
		diff.stickyNotes.changed.length === 0 &&
		(options.ignoreLayout === true ||
			(diff.moved.length === 0 && diff.stickyNotes.moved.length === 0))
	);
}
