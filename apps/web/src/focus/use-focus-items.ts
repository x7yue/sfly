import {
	type ChartView,
	FOCUS_ITEMS_MAX,
	type FocusItemInput,
	type FocusItemView,
	focusKey,
	orchestrationsApi,
	queryKey,
	runFocusApi,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "#/components/feedback/notify";
import { apiQuery, callApi } from "#/lib/api";
import { TERM } from "#/lib/copy";
import { errorText } from "#/lib/format";

/** 关注项视图里的一项，换回请求里的写法（不带状态）。 */
const focusInputOf = ({ node_id, chart, title }: FocusItemView): FocusItemInput => ({
	node_id,
	chart,
	...(title === undefined ? {} : { title }),
});

export const isFocused = (items: readonly FocusItemView[], nodeId: string, chart: string) => {
	const key = focusKey({ node_id: nodeId, chart });
	return items.some((item) => focusKey(item) === key);
};

/**
 * 场景的关注项（GLOSSARY「关注项」）：读场景视图里的 `focus_items`，改的时候整份替换（`PATCH /orchestrations/:id`）。
 * 关注项不属于场景版本，改了立即生效，不要求先保存。点击后立刻显示新列表，写入按先后顺序一个个发出，
 * 失败时通知原因并重新读取服务端的列表。列表里的项都是视图（带状态和图表类型）：点击后显示的就是传进来的这份。
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
		onError: (error) =>
			notify.error(`无法修改${TERM.focusItem}`, { description: errorText(error) }),
		onSettled: () => {
			// 最后一个写入结束时，以服务端的列表（带状态、最后修改）为准；运行的关注项读数也重新读（已经结束的运行不再轮询，
			// 在画布运行状态的检查器里开关后，概览里要马上出现或撤下这一项）。
			if (queryClient.isMutating({ mutationKey: writing }) <= 1) {
				void queryClient.invalidateQueries({ queryKey: detail.queryKey });
				void queryClient.invalidateQueries({ queryKey: queryKey(runFocusApi.focus) });
			}
		},
	});
	const items = scene.data?.focus_items ?? [];
	const invalid = items.filter((item) => item.status !== "ok").length;

	/** 整份替换成 `next`（顺序就是显示顺序）。 */
	const replace = (next: FocusItemView[]) => {
		void queryClient.cancelQueries({ queryKey: detail.queryKey });
		queryClient.setQueryData(detail.queryKey, (old) => old && { ...old, focus_items: next });
		write.mutate(next.map(focusInputOf));
	};

	return {
		items,
		/** 已用名额：包括已经失效的项。 */
		used: items.length,
		/** 其中已经失效的项数。 */
		invalid,
		/** 最后一次修改（谁、什么时候、改了什么）；从没改过为 null。 */
		edit: scene.data?.focus_edit ?? null,
		/** 场景的最新版本号：失效的项要写明「不在最新版本 vN 里」。 */
		headVersion: scene.data?.head_version ?? 0,
		limit: FOCUS_ITEMS_MAX,
		full: items.length >= FOCUS_ITEMS_MAX,
		replace,
		/**
		 * 把图表设为关注项（加到列表末尾，先当作可用：服务端检查过才会写入，不合格就以服务端的列表为准）或取消；
		 * 快速连点时以刚显示的列表为准。
		 */
		toggle: (nodeId: string, chart: string, chartType: ChartView["type"], on: boolean) => {
			const current = queryClient.getQueryData(detail.queryKey)?.focus_items ?? [];
			if (isFocused(current, nodeId, chart) === on) return;
			const key = focusKey({ node_id: nodeId, chart });
			replace(
				on
					? [...current, { node_id: nodeId, chart, status: "ok", chart_type: chartType }]
					: current.filter((item) => focusKey(item) !== key),
			);
		},
	};
}

export type FocusItems = ReturnType<typeof useFocusItems>;
