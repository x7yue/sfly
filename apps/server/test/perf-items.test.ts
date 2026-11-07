// 性能测试（ARCHITECTURE §7.6）的项注册与目标：目标只写在 ARCHITECTURE §7.6 一处，报告从那里读取。
// 负载测试本身（pnpm perf）不进 CI，这里只检查项的声明与目标表一致。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDuration, parseOptions } from "../perf/options.js";
import { loadItems, selectItems } from "../perf/registry.js";
import { parseTargets } from "../perf/targets.js";
import { repoRoot } from "./support/agent-binary.js";

describe("ARCHITECTURE §7.6 的目标表", () => {
	it("按「范围 → 目标」读出 §7.6 里的表格，不读其他章节的表格", () => {
		const md = [
			"### 7.5 别的",
			"",
			"| 范围 | 目标 |",
			"|---|---|",
			"| 不相关 | 不读 |",
			"",
			"### 7.6 性能测试",
			"",
			"目标（release 构建）：",
			"",
			"| 范围 | 目标 |",
			"|---|---|",
			"| 单个任务 SDK → Agent | 持续每秒 1 万次事件不阻塞节点 |",
			"| 节点大量输出 stdout | 每秒 10 MB 时 Agent 内存有上限，`stdout.log` 最多 16 MiB |",
			"",
			"## 8. 分阶段计划",
			"",
			"| 范围 | 目标 |",
			"|---|---|",
			"| 也不读 | x |",
		].join("\n");
		expect(parseTargets(md)).toEqual(
			new Map([
				["单个任务 SDK → Agent", "持续每秒 1 万次事件不阻塞节点"],
				["节点大量输出 stdout", "每秒 10 MB 时 Agent 内存有上限，`stdout.log` 最多 16 MiB"],
			]),
		);
	});

	it("仓库里的 ARCHITECTURE.md 能读出目标表", async () => {
		const targets = parseTargets(await readFile(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8"));
		expect(targets.get("单个任务 SDK → Agent")).toBe("持续每秒 1 万次事件不阻塞节点");
	});
});

describe("项的注册", () => {
	it("perf/items 下每个文件一项：标识唯一、与文件名一致，范围都能在 §7.6 的目标表里找到", async () => {
		const items = await loadItems();
		expect(items.length).toBeGreaterThan(0);
		const ids = items.map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
		const targets = parseTargets(await readFile(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8"));
		for (const item of items) {
			if (item.scope !== null) expect(targets.has(item.scope), item.id).toBe(true);
		}
		expect(ids[0]).toBe("single-task-events");
	});

	it("--only 按给定顺序选出项；不认识的标识报错并列出可用的项", () => {
		const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(selectItems(items, null)).toEqual(items);
		expect(selectItems(items, ["c", "a"])).toEqual([{ id: "c" }, { id: "a" }]);
		expect(() => selectItems(items, ["a", "x"])).toThrow("不认识的项：x（可用：a, b, c）");
	});
});

describe("命令行参数", () => {
	it("默认运行全部项，临时目录与结果目录在仓库的 out/perf 下", () => {
		expect(parseOptions([], {}, "/repo")).toEqual({
			only: null,
			tmpDir: "/repo/out/perf/tmp",
			outDir: "/repo/out/perf",
			build: true,
			list: false,
			soakSeconds: null,
		});
	});

	it("--only 可以重复或用逗号分隔；临时目录可以用参数或 SFLY_PERF_TMPDIR 指定", () => {
		expect(
			parseOptions(
				["--only", "a,b", "--only=c", "--tmp-dir", "rel/tmp", "--no-build", "--out-dir", "/o"],
				{ SFLY_PERF_TMPDIR: "/ignored" },
				"/repo",
			),
		).toEqual({
			only: ["a", "b", "c"],
			tmpDir: "/repo/rel/tmp",
			outDir: "/o",
			build: false,
			list: false,
			soakSeconds: null,
		});
		expect(parseOptions([], { SFLY_PERF_TMPDIR: "/big/tmp" }, "/repo").tmpDir).toBe("/big/tmp");
		expect(parseOptions(["--list"], {}, "/repo").list).toBe(true);
	});

	it("不认识的参数报错", () => {
		expect(() => parseOptions(["--bogus"], {}, "/repo")).toThrow(/bogus/);
	});

	it("--soak（pnpm perf:soak）默认运行 1 小时，结果单独放在 out/perf/soak 下，不与 pnpm perf 的结果互相对比", () => {
		const options = parseOptions(["--soak"], {}, "/repo");
		expect(options.soakSeconds).toBe(3600);
		expect(options.outDir).toBe("/repo/out/perf/soak");
		expect(options.tmpDir).toBe("/repo/out/perf/tmp");
		expect(parseOptions(["--soak", "--out-dir", "o"], {}, "/repo").outDir).toBe("/repo/o");
	});

	it("--duration 指定长时负载测试的时长", () => {
		expect(parseOptions(["--soak", "--duration", "5m"], {}, "/repo").soakSeconds).toBe(300);
		expect(parseOptions(["--soak", "--duration=1h30m"], {}, "/repo").soakSeconds).toBe(5400);
	});

	it("--duration 只用于 --soak；--soak 只有一项长时负载，不能与 --only 同用", () => {
		expect(() => parseOptions(["--duration", "5m"], {}, "/repo")).toThrow("--duration 只用于");
		expect(() => parseOptions(["--soak", "--only", "a"], {}, "/repo")).toThrow("--only");
	});
});

describe("时长", () => {
	it("接受秒数，或数字加单位 s、m、h 的组合", () => {
		expect(parseDuration("90")).toBe(90);
		expect(parseDuration("90s")).toBe(90);
		expect(parseDuration("5m")).toBe(300);
		expect(parseDuration("2h")).toBe(7200);
		expect(parseDuration("1h30m")).toBe(5400);
		expect(parseDuration("1m30s")).toBe(90);
		expect(parseDuration("0.5h")).toBe(1800);
	});

	it("零、负数和写错的时长报错", () => {
		for (const text of ["", "0", "0m", "-5m", "5x", "m", "1h 30m", "5m1h"]) {
			expect(() => parseDuration(text), text).toThrow("无效的时长");
		}
	});
});
