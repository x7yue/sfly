// 性能测试的一项（负载测试或基准测试）的接口。每项一个文件放在 perf/items/ 下，registry.ts 自动发现，
// 新增一项不需要改别的文件。写法见 items/01-single-task-events.ts。
import type { Check, Measurement, Series } from "./report.js";

/** 构建好的被测对象。 */
export interface Artifacts {
	/** release 构建的 Agent 二进制。 */
	agentBin: string;
	/** 打包后的控制面目录（含 main.mjs）。 */
	bundleDir: string;
}

/** 运行一项时可用的环境。 */
export interface PerfContext {
	/** 这一项独占的临时目录（项结束后删除）；进程环境变量 TMPDIR 也指向它。 */
	readonly tmpDir: string;
	readonly repoRoot: string;
	readonly artifacts: Artifacts;
	/** 用户中断（Ctrl-C）时触发；长时间的等待应该响应它。 */
	readonly signal: AbortSignal;
	/** 登记一个清理动作：这一项结束（成功、失败或中断）后按登记的相反顺序执行。 */
	defer(cleanup: () => unknown): void;
	/** 进度输出（打印到终端，不进报告）。 */
	log(message: string): void;
}

/** 一项的运行结果；硬性断言不满足时不要抛出，而是如实返回数值，由报告判定。 */
export interface ItemRun {
	measurements: Measurement[];
	notes?: string[];
	/** 随时间变化的数据（内存曲线等），写进 report.json。 */
	series?: Series[];
}

export interface PerfItem {
	/** 唯一标识（`--only` 用），必须与文件名去掉序号前缀后的部分一致：`01-single-task-events.ts` → `single-task-events`。 */
	id: string;
	/** 报告里的标题。 */
	title: string;
	/** ARCHITECTURE §7.6 目标表里的「范围」，报告从那里读取目标原文；没有目标的项（基准测试）为 null。 */
	scope: string | null;
	/** 是否需要 release Agent 和打包后的控制面；所选的项都不需要时跳过构建。 */
	needsArtifacts: boolean;
	run(ctx: PerfContext): Promise<ItemRun>;
}

/** 定义一项（只做类型检查）。 */
export const definePerfItem = (item: PerfItem): PerfItem => item;

/** 硬性断言（资源上限、数据正确）：不满足时该项不通过，`pnpm perf` 以非零退出码结束。 */
export const hard = (op: Check["op"], value: number): Check => ({ kind: "hard", op, value });

/** 目标（吞吐、延迟、CPU）：只记录，比目标差一半以上时提示。 */
export const target = (op: Check["op"], value: number): Check => ({ kind: "target", op, value });
