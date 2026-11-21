import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// drizzle 的迁移器只执行 `when` 比库里最后一条迁移记录晚的迁移，不看编号：合入时如果只改了编号、
// 保留了更早生成的 `when`，在已经执行过较新迁移的库上，这条迁移会被静默跳过。
// 所以日志里的 `when` 必须按编号严格递增（并行分支合并后撞上这一条的，把新迁移的 `when` 改成更晚的时间）。

const journal = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/_journal.json"),
		"utf8",
	),
) as { entries: Array<{ idx: number; tag: string; when: number }> };

describe("迁移日志", () => {
	it("`when` 按编号严格递增（不会有迁移被已执行过较新迁移的库静默跳过）", () => {
		const { entries } = journal;
		expect(entries.map((e) => e.idx)).toEqual([...entries.map((e) => e.idx)].sort((a, b) => a - b));
		for (const [i, entry] of entries.entries()) {
			const previous = entries[i - 1];
			if (!previous) continue;
			expect(
				entry.when,
				`迁移 ${entry.tag} 的 when 不晚于 ${previous.tag}：把它改成比 ${previous.when} 更晚的时间`,
			).toBeGreaterThan(previous.when);
		}
	});

	it("每条迁移的 tag 以它的编号开头", () => {
		for (const entry of journal.entries) {
			expect(entry.tag.startsWith(String(entry.idx).padStart(4, "0"))).toBe(true);
		}
	});
});
