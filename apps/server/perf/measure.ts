// 各项共用的测量换算：字节换算、被测进程（Agent、控制面）的内存与 CPU 数值与曲线。
// 数值的 id 与上一次结果对比时要保持不变（见 report.ts 的 Measurement.id）。
import type { Check, Measurement, Series } from "./report.js";
import type { ProcessUsage } from "./stack.js";

export const MB = 1024 * 1024;

/** 被测进程：id 是数值 id 的前缀，label 是报告里名称的前缀（英文名后面带空格）。 */
export interface ProcessRole {
	id: "agent" | "server";
	label: string;
}

export const AGENT: ProcessRole = { id: "agent", label: "Agent " };
export const CONTROL_PLANE: ProcessRole = { id: "server", label: "控制面" };

/**
 * 一个进程的资源数值：内存增量（峰值 - 开始，可带判定）、峰值内存、平均 CPU，以及内存曲线。
 * noise 是与上一次对比时的正常波动（内存 MB、CPU 百分点）。
 */
export function usageMeasurements(
	usage: ProcessUsage,
	role: ProcessRole,
	noise: { rssMb: number; cpuPercent: number },
	growthCheck?: Check,
): { growth: Measurement; peak: Measurement; cpu: Measurement; series: Series } {
	return {
		growth: {
			id: `${role.id}_rss_growth_mb`,
			label: `${role.label}内存增量（峰值 - 开始）`,
			value: (usage.peakRssBytes - usage.startRssBytes) / MB,
			unit: "MB",
			noise: noise.rssMb,
			...(growthCheck && { check: growthCheck }),
		},
		peak: {
			id: `${role.id}_peak_rss_mb`,
			label: `${role.label}峰值内存（RSS）`,
			value: usage.peakRssBytes / MB,
			unit: "MB",
			noise: noise.rssMb,
		},
		cpu: {
			id: `${role.id}_cpu_percent`,
			label: `${role.label}平均 CPU（单核 = 100%）`,
			value: usage.cpuPercent,
			unit: "%",
			noise: noise.cpuPercent,
		},
		series: {
			id: `${role.id}_rss`,
			label: `${role.label}内存（RSS）`,
			unit: "MB",
			points: usage.samples.map((p) => [p.ms, p.rssBytes / MB]),
		},
	};
}
