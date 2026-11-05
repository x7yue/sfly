const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 运行、任务、编排等的 ID 都是 UUID；路径参数或 Agent 上报的 ID 格式不对时直接当作不存在。 */
export const isUuid = (value: string): boolean => UUID.test(value);
