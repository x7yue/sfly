import { orchestrationsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ErrorState } from "#/components/feedback/states";
import { SCENARIO_TABS } from "#/editor/inspector/Inspector";
import { ScenarioEditor } from "#/editor/ScenarioEditor";
import { apiQuery } from "#/lib/api";

/**
 * 编排画布：全屏页，不带侧边栏和顶栏（原型 #/editor/:id）。
 * `?run=<运行 ID>` 打开时进入「运行状态」模式并叠加该运行（监控页「在画布中查看」）；
 * `?node=<节点 ID>` 打开时选中该节点（运行抽屉里预检问题的「前往」）；
 * `?settings=focus` 打开时没选中节点，场景设置停在「关注项」页（运行监控概览的「设置关注项」）。
 */
export const Route = createFileRoute("/orchestrations/$id")({
	validateSearch: z.object({
		run: z.string().optional(),
		node: z.string().optional(),
		settings: z.enum(SCENARIO_TABS).optional().catch(undefined),
	}),
	component: EditorPage,
});

function EditorPage() {
	const { id } = Route.useParams();
	const { run, node, settings } = Route.useSearch();
	const orchestration = useQuery(apiQuery(orchestrationsApi.get, { params: { id } }));
	// 编辑起点只在进入页面时读取一次，避免后台刷新覆盖正在编辑的内容。
	const head = useQuery({
		...apiQuery(orchestrationsApi.head, { params: { id } }),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	const failed = orchestration.error ?? head.error;
	if (failed && (!orchestration.data || !head.data)) {
		return (
			<div className="fixed inset-0 overflow-auto bg-bg p-6">
				<ErrorState
					title="无法加载场景"
					error={failed}
					onRetry={() => {
						void orchestration.refetch();
						void head.refetch();
					}}
				/>
			</div>
		);
	}
	if (!orchestration.data || !head.data) {
		return (
			<output
				aria-label="加载中"
				className="fixed inset-0 grid place-items-center bg-canvas-bg text-sm text-fg-3"
			>
				加载场景…
			</output>
		);
	}
	return (
		<ScenarioEditor
			key={`${id}:${run ?? ""}`}
			orchestration={orchestration.data}
			head={head.data}
			initialRun={run}
			initialNode={node}
			initialSettings={settings}
		/>
	);
}
