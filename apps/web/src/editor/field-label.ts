import type { DocNode } from "#/components/canvas/flow";

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
					? `参数 ${name}（第 ${index + 1} 个）的${item}`
					: `第 ${index + 1} 个参数的${item}`;
			}
		}
	}
	if ((head === "inputs" || head === "value") && second !== undefined) {
		if (node.kind === "feishu_notify") return NODE_FIELD[second] ?? `输入 ${second}`;
		return node.kind === "async" ? `子流程参数 ${second}` : `输入 ${second}`;
	}
	return NODE_FIELD[head] ?? field;
}

const PARAM_ITEM: Record<string, string> = {
	name: "名称",
	type: "类型",
	description: "说明",
	default: "默认值",
	required: "必填",
	secret: "敏感",
};

/** 节点上的单个字段：名称与检查器里的字段标签一致。 */
const NODE_FIELD: Record<string, string> = {
	agent: "节点 Agent",
	timeout: "超时",
	retries: "重试次数",
	queue_timeout: "排队超时",
	always: "always",
	duration: "等待时长",
	at: "触发时刻",
	tz: "时区",
	name: "子流程名称",
	subflow: "要停止的子流程",
	bot: "飞书机器人",
	format: "格式",
	text: "文本",
	at_all: "@所有人",
	title: "标题",
	color: "标题颜色",
	markdown: "正文",
	message: "原始消息",
	package: "节点包",
	node: "节点类型",
	note: "备注",
};

const EDGE_END: Record<string, string> = { from: "起点", to: "终点", kind: "类型" };

function sceneField(head: string, second?: string, third?: string): string | undefined {
	if (head === "default_agent") return "默认 Agent";
	if (head === "packages" && second !== undefined) return `节点包 ${second} 的版本`;
	if (head === "edges" && second !== undefined && third !== undefined) {
		const index = Number(second);
		const end = EDGE_END[third];
		if (Number.isInteger(index) && end) return `第 ${index + 1} 条连线的${end}`;
	}
	return undefined;
}
