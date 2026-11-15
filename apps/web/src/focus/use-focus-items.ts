import {
	FOCUS_ITEMS_MAX,
	type FocusItemInput,
	type FocusItemView,
	orchestrationsApi,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "#/components/feedback/notify";
import { apiQuery, callApi } from "#/lib/api";
import { errorText } from "#/lib/format";

/** 关注项视图里的一项，换回请求里的写法（不带状态）。 */
export const focusInputOf = ({ node_id, chart, title }: FocusItemView): FocusItemInput => ({
	node_id,
	chart,
	...(title === undefined ? {} : { title }),
});

const isItem = (item: { node_id: string; chart: string }, nodeId: string, chart: string) =>
	item.node_id === nodeId && item.chart === chart;

export const isFocused = (items: readonly FocusItemView[], nodeId: string, chart: string) =>
	items.some((item) => isItem(item, nodeId, chart));

/**
 * 写入还没有返回时先显示的项：已经在列表里的沿用现在的样子，新加的当作可用（服务端检查过才会写入，
 * 不合格就以服务端的列表为准）。改名要等服务端的列表回来才显示。
 */
function pendingItem(current: readonly FocusItemView[], input: FocusItemInput): FocusItemView {
	const { node_id, chart, title } = input;
	return (
		current.find((item) => isItem(item, node_id, chart)) ?? {
			node_id,
			chart,
			status: "ok",
			...(title === undefined ? {} : { title }),
		}
	);
}

/**
 * 场景的关注项（GLOSSARY「关注项」）：读场景视图里的 `focus_items`，改的时候整份替换（`PATCH /orchestrations/:id`）。
 * 关注项不属于场景版本，改了立即生效，不要求先保存。点击后立刻显示新列表，写入按先后顺序一个个发出，
 * 失败时通知原因并重新读取服务端的列表。
 */
export function useFocusItems(orchestrationId: string) {
	const queryClient = useQueryClient();
	const params = { id: orchestrationId };
	const detail = apiQuery(orchestrationsApi.get, { params });
	const scene = useQuery(detail);
	const writing = [`focus-items:${orchestrationId}`];
	const write = useMutation({
		mutationKey: writing,
		scope: { id: writing[0] as string },
		mutationFn: (items: FocusItemInput[]) =>
			callApi(orchestrationsApi.update, { params, body: { focus_items: items } }),
		onError: (error) => notify.error("无法修改关注项", { description: errorText(error) }),
		onSettled: () => {
			// 最后一个写入结束时，以服务端的列表（带状态、最后修改）为准。
			if (queryClient.isMutating({ mutationKey: writing }) <= 1) {
				void queryClient.invalidateQueries({ queryKey: detail.queryKey });
			}
		},
	});
	const items = scene.data?.focus_items ?? [];

	/** 整份替换成 `next`（顺序就是显示顺序）。 */
	const replace = (next: FocusItemInput[]) => {
		void queryClient.cancelQueries({ queryKey: detail.queryKey });
		queryClient.setQueryData(
			detail.queryKey,
			(old) =>
				old && { ...old, focus_items: next.map((item) => pendingItem(old.focus_items, item)) },
		);
		write.mutate(next);
	};

	return {
		items,
		/** 已用名额：包括已经失效的项。 */
		used: items.length,
		limit: FOCUS_ITEMS_MAX,
		full: items.length >= FOCUS_ITEMS_MAX,
		replace,
		/** 把图表设为关注项（加到列表末尾）或取消；快速连点时以刚显示的列表为准。 */
		toggle: (nodeId: string, chart: string, on: boolean) => {
			const current = queryClient.getQueryData(detail.queryKey)?.focus_items ?? [];
			if (isFocused(current, nodeId, chart) === on) return;
			replace(
				on
					? [...current.map(focusInputOf), { node_id: nodeId, chart }]
					: current.filter((item) => !isItem(item, nodeId, chart)).map(focusInputOf),
			);
		},
	};
}

export type FocusItems = ReturnType<typeof useFocusItems>;
