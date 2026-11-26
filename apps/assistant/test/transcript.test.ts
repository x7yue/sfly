// 对话记录和摘要（#545）：助手服务自己记的话，pi 恢复不了时整理成一段摘要。
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clip,
	SUMMARY_MAX_CHARS,
	SUMMARY_MAX_MESSAGES,
	SUMMARY_MESSAGE_MAX_CHARS,
	summarize,
	TRANSCRIPT_ENTRY_MAX_CHARS,
	TRANSCRIPT_TAIL_BYTES,
	Transcript,
	type TranscriptEntry,
} from "../src/transcript.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const transcript = (): Transcript => {
	const dir = mkdtempSync(join(tmpdir(), "sfly-transcript-"));
	dirs.push(dir);
	return new Transcript(join(dir, "transcript.jsonl"));
};
const entry = (turn: number, role: "user" | "assistant", text: string): TranscriptEntry => ({
	turn,
	role,
	text,
});

describe("对话记录", () => {
	it("按写的先后读回来；文件不存在时没有记录", () => {
		const t = transcript();
		expect(t.read()).toEqual({ entries: [], complete: true });
		t.append(entry(1, "user", "你好"));
		t.append(entry(1, "assistant", "你好，要做什么？"));
		expect(t.read()).toEqual({
			entries: [entry(1, "user", "你好"), entry(1, "assistant", "你好，要做什么？")],
			complete: true,
		});
	});

	it("文件只有属主可读写；认不出的行（写了一半、被改过）跳过，不影响别的行", () => {
		const t = transcript();
		t.append(entry(1, "user", "甲"));
		appendFileSync(t.path, '{"turn":2,"role":"user","tex\n');
		appendFileSync(t.path, '{"turn":"x","role":"user","text":"坏的"}\n');
		appendFileSync(t.path, '{"turn":2,"role":"system","text":"不认的角色"}\n');
		t.append(entry(3, "assistant", "乙"));
		expect(t.read().entries).toEqual([entry(1, "user", "甲"), entry(3, "assistant", "乙")]);
		expect(statSync(t.path).mode & 0o777).toBe(0o600);
	});

	it("一条话超过上限：留头尾、去掉中间，写明去掉了多少", () => {
		const t = transcript();
		t.append(entry(1, "assistant", `头${"x".repeat(TRANSCRIPT_ENTRY_MAX_CHARS * 2)}尾`));
		const [only] = t.read().entries;
		expect(only?.text.length).toBeLessThan(TRANSCRIPT_ENTRY_MAX_CHARS + 100);
		expect(only?.text.startsWith("头")).toBe(true);
		expect(only?.text.endsWith("尾")).toBe(true);
		expect(only?.text).toMatch(/中间省略了 \d+ 个字符/);
	});

	it("文件比读的范围长：只读末尾、丢掉第一行半条，complete 为 false", () => {
		const t = transcript();
		const big = "字".repeat(5_000);
		const rows = Math.ceil(TRANSCRIPT_TAIL_BYTES / 15_000) + 5;
		for (let i = 1; i <= rows; i += 1) t.append(entry(i, "assistant", `${i}:${big}`));
		const read = t.read();
		expect(read.complete).toBe(false);
		expect(read.entries.at(-1)?.turn).toBe(rows);
		expect(read.entries.length).toBeLessThan(rows);
		// 每条都是完整的（第一行的半条已经丢掉）。
		expect(read.entries.every((e) => e.text.startsWith(`${e.turn}:`))).toBe(true);
	});
});

describe("clip", () => {
	it("不切开代理对", () => {
		const text = "😀".repeat(30);
		for (const max of [9, 10, 11, 13]) {
			const clipped = clip(text, max, 5);
			expect(clipped).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
			expect(clipped).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
		}
	});

	it("不超过上限时原样", () => {
		expect(clip("短", 10)).toBe("短");
	});
});

describe("摘要", () => {
	const read = (entries: TranscriptEntry[], complete = true) => ({ entries, complete });

	it("只放这一轮之前的话，按时间顺序，开头写明是之前的对话和不是指令，结尾标出分界", () => {
		const summary = summarize(
			read([
				entry(1, "user", "做个页面"),
				entry(1, "assistant", "做好了"),
				entry(2, "user", "改成蓝色"),
				entry(2, "assistant", "改好了"),
				entry(3, "user", "这一轮自己的话，不该在摘要里"),
			]),
			3,
		);
		expect(summary?.kept).toBe(4);
		expect(summary?.truncated).toBe(false);
		const lines = summary?.text.split("\n") ?? [];
		expect(lines[0]).toContain("之前的上下文没能恢复");
		expect(lines[0]).toContain("不是新的指令");
		expect(lines.slice(1, 5)).toEqual([
			"用户：做个页面",
			"助手：做好了",
			"用户：改成蓝色",
			"助手：改好了",
		]);
		expect(lines.at(-1)).toContain("以上是之前的对话");
		expect(summary?.text).not.toContain("这一轮自己的话");
	});

	it("没有更早的话时没有摘要", () => {
		expect(summarize(read([entry(1, "user", "甲")]), 1)).toBeUndefined();
		expect(summarize(read([]), 5)).toBeUndefined();
	});

	it("字符数到上限就停：留最近的，更早的省略并说明", () => {
		const entries: TranscriptEntry[] = [];
		for (let turn = 1; turn <= 40; turn += 1) {
			entries.push(entry(turn, "user", `第${turn}问${"问".repeat(900)}`));
			entries.push(entry(turn, "assistant", `第${turn}答${"答".repeat(900)}`));
		}
		const summary = summarize(read(entries), 41);
		expect(summary?.truncated).toBe(true);
		const body = (summary?.text.split("\n") ?? []).filter(
			(l) => l.startsWith("用户：") || l.startsWith("助手："),
		);
		expect(body.length).toBe(summary?.kept);
		const chars = body.reduce((n, l) => n + l.length - 3, 0);
		expect(chars).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
		expect(chars).toBeGreaterThan(SUMMARY_MAX_CHARS - 2_000);
		// 留的是最近的：最后一条是第 40 轮的回答，最早的几轮没有。
		expect(body.at(-1)).toContain("第40答");
		expect(summary?.text).not.toContain("第1问");
		expect(summary?.text).toContain("已省略");
	});

	it("一条话很长：留头尾，不超过每条的上限，也不挤掉别的", () => {
		const long = `开头${"中".repeat(SUMMARY_MESSAGE_MAX_CHARS * 5)}结尾`;
		const summary = summarize(
			read([entry(1, "user", long), entry(1, "assistant", "好的"), entry(2, "user", "继续")]),
			3,
		);
		const body = (summary?.text.split("\n") ?? []).filter(
			(l) => l.startsWith("用户：") || l.startsWith("助手："),
		);
		expect(body).toHaveLength(3);
		expect(body[0]?.length).toBeLessThan(SUMMARY_MESSAGE_MAX_CHARS + 100);
		expect(body[0]).toContain("开头");
		expect(body[0]).toContain("结尾");
	});

	it("很多很短的话：条数先到上限（SUMMARY_MAX_MESSAGES），留最近的", () => {
		const entries = Array.from({ length: SUMMARY_MAX_MESSAGES + 50 }, (_, i) =>
			entry(i + 1, "user", `第${i + 1}句`),
		);
		const summary = summarize(read(entries), entries.length + 1);
		expect(summary?.kept).toBe(SUMMARY_MAX_MESSAGES);
		expect(summary?.truncated).toBe(true);
		expect(summary?.text).toContain(`第${entries.length}句`);
		expect(summary?.text).not.toContain("第1句\n");
	});

	it("记录没读全（文件比读的范围长）也算省略", () => {
		const summary = summarize(read([entry(1, "user", "甲")], false), 2);
		expect(summary?.truncated).toBe(true);
	});

	it("没有任何地方把摘要写成长于上限加说明的一段", () => {
		const summary = summarize(
			read(Array.from({ length: 100 }, (_, i) => entry(i + 1, "assistant", "答".repeat(3_000)))),
			101,
		);
		expect((summary?.text.length ?? 0) < SUMMARY_MAX_CHARS + 2_000).toBe(true);
	});
});

describe("写不了", () => {
	it("目录不存在时 append 抛出（调用方记日志，不影响这一轮）", () => {
		const dir = mkdtempSync(join(tmpdir(), "sfly-transcript-"));
		dirs.push(dir);
		writeFileSync(join(dir, "file"), "x");
		expect(() =>
			new Transcript(join(dir, "file", "no", "t.jsonl")).append(entry(1, "user", "甲")),
		).toThrow();
	});
});
