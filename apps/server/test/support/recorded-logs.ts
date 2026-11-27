import { expect } from "vitest";
import type { FakeAgent, TaskRef } from "./fake-agent.js";
import { SseClient } from "./sse-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * Agent 上报 `count` 行日志（序号从 1 起），等到控制面写进文件、数据库也记下了字节数（`tasks.log_bytes`）。
 *
 * 不能等分页里的 `last_seq`（#790）：控制面先追加文件、更新内存里的序号，再写数据库，数据库写完才把「记下的字节数」改成新的；
 * 中间读到的页 `last_seq` 已经是新的，判断文件变短用的字节数还是旧的。这时截短文件，页里不会说 `short`。
 * 实时流推送新行是在记下字节数之后：先连上这个任务的日志流、收到连上时的那一批，再上报，收到最后一行就说明已经记下了。
 */
export async function writeRecordedLogs(
	cp: TestControlPlane,
	agent: FakeAgent,
	task: TaskRef,
	count: number,
): Promise<void> {
	if (count === 0) return;
	const stream = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
	try {
		await stream.next("logs");
		agent.logs(
			task,
			Array.from({ length: count }, (_, i): [number, string] => [i + 1, `第 ${i + 1} 行`]),
		);
		let last = 0;
		while (last < count) {
			const { data } = await stream.next<{ lines: { seq: number }[] }>("logs", {
				timeoutMs: 30_000,
			});
			last = data.lines.at(-1)?.seq ?? last;
		}
		expect(last).toBe(count);
	} finally {
		stream.close();
	}
}
