import { hashKey, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * 定时重新读的查询不再定时读的那一刻再读一次：任务结束时的那一份（例如正在做的为空、最终值）不会漏掉。
 * `polling` 是此刻正在定时重新读的查询的 key；一个 key 从里面消失，就再读它一次，换了一个查询（新的 key 出现、
 * 旧的消失）时旧的没有人在看，只标成过期。多个查询（`useQueries`）和单个查询共用。
 */
export function useRefetchWhenPollingStops(polling: readonly QueryKey[]): void {
	const queryClient = useQueryClient();
	const before = useRef(new Map<string, QueryKey>());
	const signature = polling.map(hashKey).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: signature 包含了 polling 的全部内容
	useEffect(() => {
		const now = new Map(polling.map((key) => [hashKey(key), key]));
		for (const [hash, key] of before.current) {
			if (!now.has(hash)) void queryClient.invalidateQueries({ queryKey: key, exact: true });
		}
		before.current = now;
	}, [signature, queryClient]);
}
