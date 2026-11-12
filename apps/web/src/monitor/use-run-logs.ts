import { type LogOrigin, logsApi, type RunLogLine } from "@sfly/schema";
import { useEffect, useRef, useState } from "react";
import { callApi } from "#/lib/api";

/** 一页的行数。 */
const PAGE = 300;

export interface RunLogs {
	lines: RunLogLine[];
	loaded: boolean;
	truncatedTasks: LogOrigin[];
	expired: boolean;
	error: string | null;
}

const empty: RunLogs = {
	lines: [],
	loaded: false,
	truncatedTasks: [],
	expired: false,
	error: null,
};

/** 一次运行全部任务合并后的最新日志（没选中节点时的日志视图，#222），换运行时重新加载。 */
export function useRunLogs(runId: string): RunLogs {
	const [logs, setLogs] = useState<RunLogs>(empty);
	const generation = useRef(0);

	useEffect(() => {
		const current = ++generation.current;
		setLogs(empty);
		callApi(logsApi.runPage, { params: { id: runId }, query: { limit: PAGE } })
			.then((page) => {
				if (generation.current !== current) return;
				setLogs({
					lines: page.lines,
					loaded: true,
					truncatedTasks: page.truncated_tasks,
					expired: page.expired,
					error: null,
				});
			})
			.catch((e: Error) => {
				if (generation.current !== current) return;
				setLogs({ ...empty, loaded: true, error: e.message });
			});
	}, [runId]);

	return logs;
}
