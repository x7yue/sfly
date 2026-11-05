import { agentsApi, orchestrationsApi } from "@sfly/schema";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ArchiveIcon,
	LayoutGridIcon,
	ListIcon,
	PlusIcon,
	SearchIcon,
	WorkflowIcon,
} from "lucide-react";
import { z } from "zod";
import { useOverlays } from "#/components/app-shell/overlays";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { ScenarioCards, ScenarioTable } from "#/scenarios/ScenarioList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";

/** 搜索、筛选与视图放在查询参数里：刷新和分享链接都保持。 */
const ScenariosSearch = z.object({
	q: z.string().optional().catch(undefined),
	status: z.enum(["running", "failed", "success"]).optional().catch(undefined),
	agent: z.string().optional().catch(undefined),
	archived: z.boolean().optional().catch(undefined),
	view: z.enum(["card", "table"]).optional().catch(undefined),
});
type ScenariosSearch = z.infer<typeof ScenariosSearch>;

export const Route = createFileRoute("/_shell/orchestrations/")({
	staticData: { crumb: "场景编排" },
	validateSearch: ScenariosSearch,
	component: ScenariosPage,
});

const STATUS_OPTIONS = [
	{ value: "all", label: "全部" },
	{ value: "running", label: "运行中" },
	{ value: "failed", label: "最近失败" },
	{ value: "success", label: "最近成功" },
] as const;

function ScenariosPage() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const overlays = useOverlays();
	const setSearch = (patch: Partial<ScenariosSearch>) =>
		navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

	const scenarios = useQuery({
		...apiQuery(orchestrationsApi.list, {
			query: {
				q: search.q || undefined,
				status: search.status,
				agent: search.agent,
				archived: search.archived ? "true" : undefined,
			},
		}),
		// 搜索、切换筛选时保留上一次的结果，不闪骨架；运行状态每 5 秒刷新。
		placeholderData: keepPreviousData,
		refetchInterval: 5_000,
	});
	const agents = useQuery(apiQuery(agentsApi.list));
	const filtered = Boolean(search.q || search.status || search.agent);
	const view = search.view ?? "card";

	return (
		<Page>
			<PageHeader
				title={search.archived ? "已归档的场景" : "场景编排"}
				count={scenarios.data?.orchestrations.length}
				actions={
					<Button variant="primary" onClick={() => overlays.open("new-scenario")}>
						<PlusIcon />
						新建场景
					</Button>
				}
			/>
			<div className="mb-3.5 flex flex-wrap items-center gap-2">
				<div className="relative w-65">
					<SearchIcon
						aria-hidden
						className="pointer-events-none absolute top-1/2 left-2.25 size-3.5 -translate-y-1/2 text-fg-3"
					/>
					<Input
						type="search"
						aria-label="搜索场景"
						placeholder="按名称、说明或 Agent 搜索"
						className="pl-7.5"
						value={search.q ?? ""}
						onChange={(e) => setSearch({ q: e.target.value || undefined })}
					/>
				</div>
				<Segmented
					label="最近运行"
					value={search.status ?? "all"}
					onChange={(v) => setSearch({ status: v === "all" ? undefined : v })}
					options={STATUS_OPTIONS}
				/>
				<NativeSelect
					aria-label="Agent"
					className="w-40"
					value={search.agent ?? ""}
					onChange={(e) => setSearch({ agent: e.target.value || undefined })}
				>
					<option value="">全部 Agent</option>
					{agents.data?.agents.map((a) => (
						<option key={a.name} value={a.name}>
							{a.name}
						</option>
					))}
				</NativeSelect>
				<span className="flex-1" />
				<Button
					variant="ghost"
					size="sm"
					aria-pressed={Boolean(search.archived)}
					className="aria-pressed:bg-raised-2 aria-pressed:text-fg-1"
					onClick={() => setSearch({ archived: search.archived ? undefined : true })}
				>
					<ArchiveIcon />
					已归档
					<span className="font-mono text-fg-3">{scenarios.data?.archived_count ?? ""}</span>
				</Button>
				<Segmented
					label="视图"
					value={view}
					onChange={(v) => setSearch({ view: v === "card" ? undefined : v })}
					options={[
						{ value: "card", label: "卡片视图", icon: <LayoutGridIcon /> },
						{ value: "table", label: "表格视图", icon: <ListIcon /> },
					]}
				/>
			</div>
			<QueryView
				query={scenarios}
				loading={
					<Panel>
						<TableSkeleton columns={6} />
					</Panel>
				}
				errorTitle="无法加载场景"
				isEmpty={(d) => d.orchestrations.length === 0}
				empty={
					<Panel>
						{filtered ? (
							<EmptyState
								icon={<SearchIcon />}
								title="没有匹配的场景"
								description="换个关键词，或清除筛选条件。"
							>
								<Button
									onClick={() => setSearch({ q: undefined, status: undefined, agent: undefined })}
								>
									清除筛选
								</Button>
							</EmptyState>
						) : search.archived ? (
							<EmptyState
								icon={<ArchiveIcon />}
								title="没有已归档的场景"
								description="归档的场景不出现在列表里、不能运行，可以在这里恢复。"
							/>
						) : (
							<EmptyState
								icon={<WorkflowIcon />}
								title="还没有场景"
								description="场景把节点串成一条测试链路。新建后自带一个入口节点；需要先发布至少一个节点包。"
							>
								<div className="flex justify-center gap-2">
									<Button onClick={() => overlays.open("new-scenario")}>
										<PlusIcon />
										新建场景
									</Button>
									<Button variant="ghost" render={<Link to="/packages" />} nativeButton={false}>
										查看节点包
									</Button>
								</div>
							</EmptyState>
						)}
					</Panel>
				}
			>
				{(data) =>
					view === "table" ? (
						<Panel>
							<ScenarioTable scenarios={data.orchestrations} />
						</Panel>
					) : (
						<ScenarioCards scenarios={data.orchestrations} />
					)
				}
			</QueryView>
		</Page>
	);
}
