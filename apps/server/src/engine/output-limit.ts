import { create } from "@bufbuild/protobuf";
import { type AgentMessage, AgentMessageSchema, ErrorKind, TaskStatus } from "@sfly/proto";

/** 节点输出（JSON 序列化后）的大小上限：1 MB（docs/ARCHITECTURE.md §4.1）。 */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 节点输出上限（#18）：成功结果的 outputs_json 超过 1 MB 时，把这条结果换成 node_error 失败再交给引擎。
 * SDK 的执行器已经在本地检查过；这里兜住不经过 SDK 的 Agent 和异常情况。
 */
export function limitOutputs(message: AgentMessage): AgentMessage {
	if (message.body.case !== "result") return message;
	const result = message.body.value;
	if (result.status !== TaskStatus.SUCCESS) return message;
	const bytes = Buffer.byteLength(result.outputsJson);
	if (bytes <= MAX_OUTPUT_BYTES) return message;
	return create(AgentMessageSchema, {
		body: {
			case: "result",
			value: {
				taskId: result.taskId,
				attempt: result.attempt,
				status: TaskStatus.FAILED,
				outputsJson: "",
				error: {
					kind: ErrorKind.NODE_ERROR,
					message: `节点输出超过 1 MB 上限（${bytes} 字节）`,
				},
			},
		},
	});
}
