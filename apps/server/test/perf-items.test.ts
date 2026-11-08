// 性能测试（ARCHITECTURE §7.6）的项注册与目标：目标只写在 ARCHITECTURE §7.6 一处，报告从那里读取。
// 负载测试本身（pnpm perf）不进 CI，这里只检查项的声明与目标表一致。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultResultsDir,
	displayPath,
	parseDuration,
	parseOptions,
	secondsFromEnv,
} from "../perf/options.js";
import { loadItems, selectItems } from "../perf/registry.js";
import {
	AGENT_RSS_GROWTH_MB,
	AGENT_SLOTS,
	DISCONNECT_SECONDS,
	END_TO_END_MS,
	EVENTS_PER_SECOND,
	INGEST_POINTS_PER_SECOND,
	INGEST_SECONDS,
	parseTargets,
	QUERY_P95_MS,
	STDOUT_LOG_MAX_MIB,
	STDOUT_MIB_PER_SECOND,
	targetQuantities,
} from "../perf/targets.js";
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

describe("§7.6 目标里的数量", () => {
	it("读出目标原文里带单位的数量：「万」乘一万，分钟、小时换算成秒；p95 这样的名字不算数量", () => {
		expect(
			targetQuantities("持续每秒 1 万点 1 小时不积压；1 小时范围的指标查询 p95 < 500 ms"),
		).toEqual([
			{ value: 10_000, unit: "点" },
			{ value: 3600, unit: "秒" },
			{ value: 3600, unit: "秒" },
			{ value: 500, unit: "ms" },
		]);
		expect(targetQuantities("断线 5 分钟内存不超过排队上限")).toEqual([{ value: 300, unit: "秒" }]);
		expect(targetQuantities("没有数量")).toEqual([]);
	});

	it("各项判定与负载用的数字与仓库里 §7.6 目标表一致（改了表要同步改 perf/targets.ts）", async () => {
		const targets = parseTargets(await readFile(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8"));
		const quantities = (scope: string) => targetQuantities(targets.get(scope) ?? "");
		expect(quantities("单个任务 SDK → Agent")).toEqual([{ value: EVENTS_PER_SECOND, unit: "次" }]);
		expect(quantities("单个 Agent")).toEqual([
			{ value: AGENT_SLOTS, unit: "个" },
			{ value: AGENT_RSS_GROWTH_MB, unit: "MB" },
		]);
		expect(quantities("节点大量输出 stdout")).toEqual([
			{ value: STDOUT_MIB_PER_SECOND, unit: "MB" },
			{ value: STDOUT_LOG_MAX_MIB, unit: "MiB" },
		]);
		expect(quantities("控制面接收指标")).toEqual([
			{ value: INGEST_POINTS_PER_SECOND, unit: "点" },
			{ value: INGEST_SECONDS, unit: "秒" },
			{ value: INGEST_SECONDS, unit: "秒" },
			{ value: QUERY_P95_MS, unit: "ms" },
		]);
		expect(quantities("端到端延迟")).toEqual([{ value: END_TO_END_MS / 1000, unit: "秒" }]);
		expect(quantities("Agent 断线")).toEqual([{ value: DISCONNECT_SECONDS, unit: "秒" }]);
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
	const HOME = { HOME: "/home/u" };

	it("默认运行全部项；结果目录在仓库之外（~/.local/share/sfly/perf，各 worktree 共用），临时目录在仓库的 out/perf/tmp", () => {
		expect(parseOptions([], HOME, "/repo")).toEqual({
			only: null,
			tmpDir: "/repo/out/perf/tmp",
			outDir: "/home/u/.local/share/sfly/perf",
			build: true,
			list: false,
			soakSeconds: null,
			release: false,
		});
	});

	it("结果目录：--out-dir 优先，其次 SFLY_PERF_DIR，再次 $XDG_DATA_HOME/sfly/perf（不是绝对路径时不算）", () => {
		const outDir = (argv: string[], env: Record<string, string>) =>
			parseOptions(argv, { ...HOME, ...env }, "/repo").outDir;
		expect(outDir([], { XDG_DATA_HOME: "/data" })).toBe("/data/sfly/perf");
		expect(outDir([], { XDG_DATA_HOME: "rel" })).toBe("/home/u/.local/share/sfly/perf");
		expect(outDir([], { XDG_DATA_HOME: "/data", SFLY_PERF_DIR: "/p" })).toBe("/p");
		expect(outDir(["--out-dir", "o"], { SFLY_PERF_DIR: "/p" })).toBe("/repo/o");
		expect(defaultResultsDir({ ...HOME, SFLY_PERF_DIR: "" })).toBe(
			"/home/u/.local/share/sfly/perf",
		);
	});

	it("显示用的路径：仓库里的相对仓库根目录，家目录下的以 ~ 开头", () => {
		expect(displayPath("/repo/docs/perf/0.0.5", "/repo", "/home/u")).toBe("docs/perf/0.0.5");
		expect(displayPath("/home/u/.local/share/sfly/perf/x", "/repo", "/home/u")).toBe(
			"~/.local/share/sfly/perf/x",
		);
		expect(displayPath("/home/uu/x", "/repo", "/home/u")).toBe("/home/uu/x");
		expect(displayPath("/srv/perf", "/repo", "/home/u")).toBe("/srv/perf");
	});

	it("--release 要完整运行、用当前提交构建，不能与 --only、--no-build 同用", () => {
		expect(parseOptions(["--release"], HOME, "/repo").release).toBe(true);
		expect(parseOptions(["--soak", "--release"], HOME, "/repo").release).toBe(true);
		expect(() => parseOptions(["--release", "--only", "a"], HOME, "/repo")).toThrow("--only");
		expect(() => parseOptions(["--release", "--no-build"], HOME, "/repo")).toThrow("--no-build");
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
			release: false,
		});
		expect(parseOptions([], { SFLY_PERF_TMPDIR: "/big/tmp" }, "/repo").tmpDir).toBe("/big/tmp");
		expect(parseOptions(["--list"], {}, "/repo").list).toBe(true);
	});

	it("不认识的参数报错", () => {
		expect(() => parseOptions(["--bogus"], {}, "/repo")).toThrow(/bogus/);
	});

	it("--soak（pnpm perf:soak）默认运行 1 小时，结果单独放在结果目录的 soak/ 下，不与 pnpm perf 的结果互相对比", () => {
		const options = parseOptions(["--soak"], HOME, "/repo");
		expect(options.soakSeconds).toBe(3600);
		expect(options.outDir).toBe("/home/u/.local/share/sfly/perf/soak");
		expect(parseOptions(["--soak"], { SFLY_PERF_DIR: "/p" }, "/repo").outDir).toBe("/p/soak");
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

describe("环境变量里的秒数（secondsFromEnv）", () => {
	const NAME = "SFLY_PERF_X_SECONDS";

	it("没设或为空时用默认值，设了就按秒数（可以带小数）", () => {
		expect(secondsFromEnv({}, NAME, 60)).toBe(60);
		expect(secondsFromEnv({ [NAME]: "" }, NAME, 60)).toBe(60);
		expect(secondsFromEnv({ [NAME]: "3600" }, NAME, 60)).toBe(3600);
		expect(secondsFromEnv({ [NAME]: "2.5" }, NAME, 60)).toBe(2.5);
	});

	it("不是正数时报错并指出变量名", () => {
		for (const bad of ["0", "-5", "abc", "1h", "5m"]) {
			expect(() => secondsFromEnv({ [NAME]: bad }, NAME, 60), bad).toThrow(NAME);
		}
	});

	it("有下限时，短于下限报错并说明原因", () => {
		const min = { seconds: 30, reason: "日志队列排满之后还要再断一会儿" };
		expect(secondsFromEnv({ [NAME]: "30" }, NAME, 45, min)).toBe(30);
		expect(() => secondsFromEnv({ [NAME]: "10" }, NAME, 45, min)).toThrow(
			`${NAME} 至少 30 秒（日志队列排满之后还要再断一会儿）：10`,
		);
	});
});
