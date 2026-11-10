import { useSyncExternalStore } from "react";

/**
 * 日志面板时间列显示哪一种时间（ADR 0018）：默认 Agent 时间，方便和被测系统自己的日志对照；
 * 可以切换成控制面时间。选择保存在 localStorage，刷新后保持。
 * 时间线定位和按时间范围过滤不看这个选择，始终用控制面时间。
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

const STORAGE_KEY = "sfly.logs.time";
const listeners = new Set<() => void>();

const read = (): LogTimeKind =>
	window.localStorage.getItem(STORAGE_KEY) === "control_plane" ? "control_plane" : "agent";

export function setLogTimeKind(kind: LogTimeKind) {
	window.localStorage.setItem(STORAGE_KEY, kind);
	for (const l of listeners) l();
}

export function useLogTimeKind(): LogTimeKind {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		read,
		() => "agent",
	);
}
