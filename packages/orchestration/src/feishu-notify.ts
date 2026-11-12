import type { OrchestrationNode } from "@sfly/schema";

export type FeishuNotifyNode = Extract<OrchestrationNode, { kind: "feishu_notify" }>;

/**
 * 飞书通知节点在当前格式下可以写引用的输入（机器人除外）：文本格式的 `text`，Markdown 卡片的 `title` 和
 * `markdown`，原始消息的 `message`（还没填写时没有这一项）。保存时的引用检查和运行时的解析都只看这些：
 * 其他格式里留着的内容不参与（docs/SEMANTICS.md §4.2）。
 */
export function feishuReferableInputs(node: FeishuNotifyNode): Record<string, unknown> {
	switch (node.format) {
		case "text":
			return { text: node.text };
		case "card":
			return { title: node.title, markdown: node.markdown };
		case "raw":
			return node.message === undefined ? {} : { message: node.message };
	}
}
