import { expect } from "vitest";
import type { FakeAgent, TaskRef } from "./fake-agent.js";
import { SseClient } from "./sse-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * Agent 上报这些序号的日志（数字 `n` 是 1 到 n；序号可以有缺口），等到控制面写进文件、数据库也记下了字节数（`tasks.log_bytes`）。
 *
 * 不能等分页里的 `last_seq`（#790）：控制面先追加文件、更新内存里的序号，再写数据库，数据库写完才把「记下的字节数」改成新的；
 * 中间读到的页 `last_seq` 已经是新的，判断文件变短用的字节数还是旧的。这时截短文件，页里不会说 `short`。
 * 实时流推送新行是在记下字节数之后：先连上这个任务的日志流、收到连上时的那一批，再上报，收到最后一行就说明已经记下了。
 */
export async function writeRecordedLogs(
	cp: TestControlPlane,
	agent: FakeAgent,
	task: TaskRef,
	lines: number | readonly number[],
): Promise<void> {
	const seqs = typeof lines === "number" ? Array.from({ length: lines }, (_, i) => i + 1) : lines;
	const last = seqs.at(-1);
	if (last === undefined) return;
	const stream = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
	try {
		await stream.next("logs");
		agent.logs(
			task,
			seqs.map((seq): [number, string] => [seq, `第 ${seq} 行`]),
		);
		let seen = 0;
		while (seen < last) {
			const { data } = await stream.next<{ lines: { seq: number }[] }>("logs", {
				timeoutMs: 30_000,
			});
			seen = data.lines.at(-1)?.seq ?? seen;
		}
		expect(seen).toBe(last);
	} finally {
		stream.close();
	}
}
