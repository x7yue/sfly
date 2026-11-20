// 经 live-run.ts 的函数读写，或者读别的接口：不拦。
export const view = runViewQuery("run-1");
export const list = queryKey(runsApi.list, { page: 1 });
export const other = apiQuery(scenariosApi.get, { id: "s-1" });
