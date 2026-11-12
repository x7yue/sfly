import type { OrchestrationNode } from "@sfly/schema";

export type FeishuNotifyNode = Extract<OrchestrationNode, { kind: "feishu_notify" }>;

/** 飞书请求体的大小上限：紧凑 JSON 按 UTF-8 编码的字节数（官方说明「不能超过 20 KB」）。控制面、画布的说明文字都从这里取。 */
export const FEISHU_BODY_LIMIT_BYTES = 20 * 1024;

/** {@link FEISHU_BODY_LIMIT_BYTES} 在说明文字里的写法：`20 KB`。 */
export const FEISHU_BODY_LIMIT_LABEL = `${FEISHU_BODY_LIMIT_BYTES / 1024} KB`;

/** 原始消息的 `msg_type` 必须是飞书自定义机器人接受的这几种之一（校验、检查器的说明共用）。 */
export const FEISHU_MSG_TYPES = ["text", "post", "image", "share_chat", "interactive"] as const;

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
