// 缓存的唯一出入口：同样的写法在这里不拦。
export const byKey = queryKey(runsApi.get, { id: "run-1" });
export const byQuery = apiQuery(runsApi.get, { id: "run-1" });
