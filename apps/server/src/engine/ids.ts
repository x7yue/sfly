import { createHash } from "node:crypto";

/**
 * 由若干部分确定性地生成 UUID（sha256 截取 16 字节，按 UUIDv8 设置版本位）。
 * 链实例 ID、任务 ID 都这样生成，崩溃恢复后重放同一步骤不会产生重复记录（docs/SEMANTICS.md §4.6）。
 */
export function deterministicId(...parts: Array<string | number>): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(`${String(part).length}:${part};`);
	const bytes = hash.digest().subarray(0, 16);
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 主链或子流程实例的 ID：运行 ID + 父链实例 ID + 异步任务节点 ID。 */
export const chainInstanceId = (runId: string, parentChainInstanceId = "", asyncNodeId = "") =>
	deterministicId("chain", runId, parentChainInstanceId, asyncNodeId);

/** 任务 ID：链实例 ID + 节点 ID + attempt。 */
export const taskId = (chainInstanceId: string, nodeId: string, attempt: number) =>
	deterministicId("task", chainInstanceId, nodeId, attempt);
