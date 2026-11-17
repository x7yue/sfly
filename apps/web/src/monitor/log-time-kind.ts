import { useSyncExternalStore } from "react";

/**
 * 日志面板时间列显示哪一种时间（ADR 0018）：默认 Agent 时间，方便和被测系统自己的日志对照；
 * 可以切换成控制面时间。选择保存在 localStorage，刷新后保持。
 * 时间线定位和按时间范围过滤不看这个选择，始终用控制面时间。
 *
 * 「动作」页签表格里的时间有自己的一份选择（默认控制面时间，和时间线一致），和日志的互不影响。
 */
export type LogTimeKind = "agent" | "control_plane";

export const LOG_TIME_KINDS: [LogTimeKind, string][] = [
	["agent", "Agent 时间"],
	["control_plane", "控制面时间"],
];

/** 一行日志在时间列上显示的时间；没有记录时为 null。 */
export const logLineTime = (
	line: { time: string | null; agent_time: string | null },
	kind: LogTimeKind,
) => (kind === "agent" ? line.agent_time : line.time);

/** 一处显示时间的选择：存在 localStorage 的 `key` 下，没存过时是 `fallback`。 */
function timeKindPreference(key: string, fallback: LogTimeKind) {
	const listeners = new Set<() => void>();
	const read = (): LogTimeKind => {
		const stored = window.localStorage.getItem(key);
		return stored === "agent" || stored === "control_plane" ? stored : fallback;
	};
	return {
		set(kind: LogTimeKind) {
			window.localStorage.setItem(key, kind);
			for (const l of listeners) l();
		},
		use: (): LogTimeKind =>
			useSyncExternalStore(
				(listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				read,
				() => fallback,
			),
	};
}

const logTime = timeKindPreference("sfly.logs.time", "agent");
export const setLogTimeKind = logTime.set;
export const useLogTimeKind = logTime.use;

const actionTime = timeKindPreference("sfly.actions.time", "control_plane");
export const setActionTimeKind = actionTime.set;
export const useActionTimeKind = actionTime.use;
