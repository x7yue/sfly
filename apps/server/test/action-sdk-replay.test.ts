import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PreparedEvent, planBatch } from "../src/actions/action-details.js";
import { makeTempDirSync } from "./support/temp-dir.js";

/**
 * 真实的 SDK 写出的事件，原样按 Agent 的分批（一批 1000 个）交给控制面的兜底（`planBatch`，纯函数，不连库）：
 * SDK 和控制面各执行一遍每种名称、合计的上限，两边要对得上，不然 SDK 认为上报了的明细被控制面丢掉，失败的动作没有明细
 * （#726：第 1001 种起的名称共用一份计数，当年写成不受每种名称的上限，控制面却照样按 5 万个丢）。
 * SDK 只用标准库，直接用 python3 跑源码。
 */

const repoRoot = join(import.meta.dirname, "../../..");

/** 用真实的 SDK 写一份事件文件。`body` 是用 `ctx` 记动作的 Python 代码。 */
function writeEvents(body: string): string[] {
	const dir = makeTempDirSync("sdk-replay-");
	try {
		const file = join(dir, "events.jsonl");
		execFileSync(
			process.env.PYTHON ?? "python3",
			[
				"-c",
				[
					"import sys",
					"from pathlib import Path",
					"from sfly import Context, TaskInfo",
					"ctx = Context(events_path=Path(sys.argv[1]), cancel_path=None, artifacts_dir=None, artifacts_url=None, task=TaskInfo())",
					body,
					"ctx.action._last_sent = -1e9",
					"ctx.action._dirty = True",
					"ctx.action.flush()",
				].join("\n"),
				file,
			],
			{ env: { ...process.env, PYTHONPATH: join(repoRoot, "sdk/python/src") } },
		);
		return readFileSync(file, "utf8").split("\n").filter(Boolean);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface Replay {
	/** 存下的明细：ID → 名称、结果、是不是补发的。 */
	rows: Map<number, { name: string; result: string | null; late: boolean }>;
	/** 控制面兜底丢弃的明细个数。 */
	dropped: number;
	/** 最后一份摘要。 */
	summary: Record<string, unknown> & {
		failed: number;
		names: { name: string; failed: number }[];
		names_complete: boolean;
		unlisted: { total: number; failed: number; reported: number } | null;
		reported: number;
	};
}

/** 事件按 1000 个一批交给 `planBatch`，和 Agent 的分批、控制面的写入一致。 */
function replay(lines: string[]): Replay {
	const at = new Date(0);
	const prepared: PreparedEvent[] = [];
	let summary: Replay["summary"] | undefined;
	for (const line of lines) {
		const e = JSON.parse(line);
		if (e.type === "action_summary") summary = e;
		else if (e.type === "mark" || e.type === "action_start")
			prepared.push({
				kind: e.type === "mark" ? "mark" : "action",
				id: e.id,
				parent: e.parent,
				depth: e.depth,
				name: e.name,
				fields: e.fields,
				late: e.late === true,
				at,
				agentAt: at,
				mono: e.mono,
			});
		else if (e.type === "action_end")
			prepared.push({
				kind: "end",
				id: e.id,
				result: e.result,
				reason: e.reason,
				fields: e.fields,
				at,
				agentAt: at,
				mono: e.mono,
			});
	}
	const rows: Replay["rows"] = new Map();
	const stored = new Map<string, number>();
	let details = 0;
	let dropped = 0;
	let rev = 0;
	for (let i = 0; i < prepared.length; i += 1000) {
		const batch = prepared.slice(i, i + 1000);
		const names = new Set(batch.flatMap((e) => (e.kind === "end" ? [] : [e.name])));
		const plan = planBatch("t", ++rev, batch, {
			details,
			stored: new Map([...names].map((n) => [n, stored.get(n) ?? 0])),
		});
		for (const { row, late, end } of plan.inserts) {
			rows.set(row.id, { name: row.name, result: end ? end.result : row.result, late });
			details += 1;
			if (!late) stored.set(row.name, (stored.get(row.name) ?? 0) + 1);
		}
		for (const end of plan.ends) {
			const row = rows.get(end.id);
			if (row) row.result = end.result;
		}
		for (const d of plan.dropped.values()) dropped += d.count;
	}
	if (!summary) throw new Error("SDK 没有写摘要");
	return { rows, dropped, summary };
}

const failedRows = (r: Replay, name: string) =>
	[...r.rows.values()].filter((row) => row.name === name && row.result === "failed");

describe("SDK 写出的事件交给控制面的兜底：两边的上限对得上", () => {
	it("第 1001 种起的一种名称成功 50005 次之后失败一次：控制面不兜底丢，失败的动作有补发的明细", () => {
		const r = replay(
			writeEvents(
				[
					"for i in range(1000):",
					'    ctx.mark(f"n{i}")',
					"for _ in range(50_005):",
					'    ctx.action.start("热点").end()',
					'ctx.action.start("热点").fail("故障")',
				].join("\n"),
			),
		);
		expect(r.dropped).toBe(0); // 控制面没有丢任何一个 SDK 上报的明细（没有触发兜底）
		const failed = failedRows(r, "热点");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.late).toBe(true); // 超过每种名称的上限之后失败：补发
		expect(r.summary.failed).toBe(1);
		expect(r.summary.names_complete).toBe(false);
		expect(r.summary.unlisted).toEqual({ total: 50_006, failed: 1, reported: 50_001 });
		// 没进名称表的名称合起来也只上报每种名称的上限（5 万个），再加上补发的那个
		expect([...r.rows.values()].filter((row) => row.name === "热点")).toHaveLength(50_001);
	});

	it("一种没进名称表的名称不能把合计的额度用光：之后名称表里的名称失败，明细照常补发", () => {
		const r = replay(
			writeEvents(
				[
					"for i in range(1000):",
					'    ctx.mark(f"n{i}")',
					"for _ in range(100_000):",
					'    ctx.mark("热点")',
					'ctx.action.start("n5").fail("故障")',
				].join("\n"),
			),
		);
		expect(r.dropped).toBe(0);
		const failed = failedRows(r, "n5");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.late).toBe(false); // n5 还没到它自己的上限：开始时就上报了，结束照常写
		// 热点 只上报了 5 万个：SDK 认为的合计（5.1 万个）没有被它用光
		expect(r.summary.reported).toBe(51_001);
		expect([...r.rows.values()].filter((row) => row.name === "热点")).toHaveLength(50_000);
		// 控制台的失败数用合计的：失败落在名称表里的名称上也照样数
		expect(r.summary.failed).toBe(1);
		expect(r.summary.names.reduce((sum, n) => sum + n.failed, 0)).toBe(1);
	});

	it("失败落在没进名称表的名称上：名称表里各项的失败数加起来是 0，摘要的合计失败数仍是对的", () => {
		const r = replay(
			writeEvents(
				[
					"for i in range(1000):",
					'    ctx.mark(f"n{i}")',
					"for i in range(5):",
					'    ctx.action.start(f"晚到{i}").fail("故障")',
				].join("\n"),
			),
		);
		expect(r.dropped).toBe(0);
		expect(r.summary.names.reduce((sum, n) => sum + n.failed, 0)).toBe(0);
		expect(r.summary.failed).toBe(5);
		expect(r.summary.unlisted).toEqual({ total: 5, failed: 5, reported: 5 });
		expect(r.summary.names_complete).toBe(false);
	});
});
