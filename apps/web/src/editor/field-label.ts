import type { DocNode } from "#/components/canvas/flow";
import { TERM } from "#/lib/copy";

/**
 * 字段错误的位置说明（纯逻辑，单测见 field-label.test.ts）：把 FieldError 的内部路径
 * （`params.0.name`、`inputs.steps`、`duration`）翻译成检查器里看得到的字段名，
 * 参数写成「参数名加第几个参数的哪一项」。认不出的路径原样返回。
 *
 * `node` 是错误所在的节点；场景级字段（`default_agent`、`edges.N.from`……）传 undefined。
 */
export function fieldLabel(node: DocNode | undefined, field: string): string {
	const [head = "", second, third] = field.split(".");
	if (!node) return sceneField(head, second, third) ?? field;

	if (head === "id") return "节点 ID";
	if (head === "params" && second !== undefined) {
		if (node.kind === "async") return `子流程参数 ${second}`;
		if (node.kind === "entry" || node.kind === "subflow_entry") {
			const index = Number(second);
			const item = third === undefined ? undefined : PARAM_ITEM[third];
			if (Number.isInteger(index) && item) {
				const name = node.params[index]?.name;
				return name
					? `参数 ${name}（第 ${index + 1} 个）的${spaced(item)}`
					: `第 ${index + 1} 个参数的${spaced(item)}`;
			}
		}
	}
	if ((head === "inputs" || head === "value") && second !== undefined) {
		return node.kind === "async" ? `子流程参数 ${second}` : `输入 ${second}`;
	}
	return NODE_FIELD[head] ?? field;
}

/** 英文（`secret`）和前面的中文之间留一个空格。 */
const spaced = (item: string) => (/^[A-Za-z]/.test(item) ? ` ${item}` : item);

/** 入口参数声明里的一项（检查器的字段错误、版本对比的差异共用一张表，#434）。 */
export const PARAM_ITEM: Record<string, string> = {
	name: "名称",
	type: "类型",
	description: "说明",
	default: "默认值",
	required: "必填",
	secret: TERM.secret,
};

/**
 * 节点上的单个字段：名称与检查器里的字段标签一致。检查器的字段错误、版本对比的差异共用这一张表（#434），
 * 不再各写一份、措辞分叉。
 */
export const NODE_FIELD: Record<string, string> = {
	display_name: TERM.displayName,
	agent: "节点 Agent",
	timeout: "超时",
	retries: "重试次数",
	queue_timeout: "排队超时",
	always: "always",
	name: "子流程名称",
	subflow: "要停止的子流程",
	package: "节点包",
	kind: "节点种类",
	node: "节点类型",
	note: TERM.note,
};

/** 场景的默认 Agent。 */
export const DEFAULT_AGENT_LABEL = "默认 Agent";

const EDGE_END: Record<string, string> = { from: "起点", to: "终点", kind: "类型" };

function sceneField(head: string, second?: string, third?: string): string | undefined {
	if (head === "default_agent") return DEFAULT_AGENT_LABEL;
	if (head === "packages" && second !== undefined) return `节点包 ${second} 的版本`;
	if (head === "edges" && second !== undefined && third !== undefined) {
		const index = Number(second);
		const end = EDGE_END[third];
		if (Number.isInteger(index) && end) return `第 ${index + 1} 条连线的${end}`;
	}
	return undefined;
}
