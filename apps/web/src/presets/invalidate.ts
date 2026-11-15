import { domainKey, presetsApi, runsApi } from "@sfly/schema";
import { useQueryClient } from "@tanstack/react-query";

/**
 * 预设改动之后让用到预设的查询全部重新获取：预设列表（presets 领域）和触发前检查（运行抽屉的预设选择框读它里面的 `presets`）。
 */
export function useInvalidatePresets() {
	const queryClient = useQueryClient();
	return () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: domainKey(presetsApi.list) }),
			queryClient.invalidateQueries({ queryKey: domainKey(runsApi.preflight) }),
		]);
}
