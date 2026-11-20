// 在 monitor/live-run.ts 之外直接读写运行视图的缓存。
// @hit
export const byKey = queryKey(runsApi.get, { id: "run-1" });
// @hit
export const byQuery = apiQuery(runsApi.get, { id: "run-1" });
