/** 飞书请求体的大小上限：紧凑 JSON 按 UTF-8 编码的字节数（官方说明「不能超过 20 KB」）。控制面的消息组装、说明文字都从这里取。 */
export const FEISHU_BODY_LIMIT_BYTES = 20 * 1024;

/** {@link FEISHU_BODY_LIMIT_BYTES} 在说明文字里的写法：`20 KB`。 */
export const FEISHU_BODY_LIMIT_LABEL = `${FEISHU_BODY_LIMIT_BYTES / 1024} KB`;

/** 原始消息（`ctx.notify(message=...)`）的 `msg_type` 必须是飞书自定义机器人接受的这几种之一。 */
export const FEISHU_MSG_TYPES = ["text", "post", "image", "share_chat", "interactive"] as const;
