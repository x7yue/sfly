import { orchestrationsApi, type RunListItem, runListApi } from "@sfly/schema";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlayIcon, SearchIcon } from "lucide-react";
import { z } from "zod";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { Page, PageHeader, Panel, SectionHeading } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { MESSAGE, PAGE } from "#/lib/copy";
import { LIVE_POLL_MS } from "#/lib/polling";
import { useNow } from "#/lib/use-now";
import { useSearchInput } from "#/lib/use-search-input";
import { RunCard } from "#/run-records/RunCard";
import { RunHistoryTable } from "#/run-records/RunHistoryTable";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";

const STATUSES = ["running", "failed", "success", "cancelled"] as const;
type StatusFilter = (typeof STATUSES)[number] | "all";

/** 筛选条件放在查询参数里，可以直接分享链接；不合法的值当作没给。 */
const RunsSearch = z.object({
	status: z.enum(STATUSES).optional().catch(undefined),
	scenario: z.string().optional().catch(undefined),
	q: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_shell/runs/")({
	staticData: { crumb: PAGE.runs },
	validateSearch: RunsSearch,
	component: RunsPage,
});

/** 运行记录（原型 #/runs）：进行中的运行是卡片，其余是历史表格。 */
function RunsPage() {
	const search = Route.useSearch();
	const runs = useQuery({
		...apiQuery(runListApi.list, {
			query: { status: search.status, orchestration_id: search.scenario, q: search.q },
		}),
		// 实时更新：进度、新运行、运行结束。
		refetchInterval: LIVE_POLL_MS,
		placeholderData: keepPreviousData,
	});
	const counts = runs.data?.counts;
	const total = counts && counts.running + counts.success + counts.failed + counts.cancelled;
	const filtered = search.status !== undefined || !!search.scenario || !!search.q;
	return (
		<Page>
			<PageHeader
				title={PAGE.runs}
				count={total}
				actions={<span className="text-xs text-fg-3">实时更新</span>}
			/>
			<Toolbar counts={counts} />
			<QueryView
				query={runs}
				loading={
					<Panel>
						<TableSkeleton columns={8} />
					</Panel>
				}
				errorTitle="无法加载运行记录"
				isEmpty={(d) => d.runs.length === 0}
				empty={
					<Panel>
						{filtered ? (
							<EmptyState
								icon={<SearchIcon />}
								title="没有符合条件的运行"
								description="换一个状态、场景或关键字试试。"
							/>
						) : (
							<EmptyState
								icon={<PlayIcon />}
								title="没有运行记录"
								description="在场景卡片上点「运行」，记录会出现在这里。"
							>
								<Link to="/orchestrations" className={buttonVariants()}>
									去场景编排
								</Link>
							</EmptyState>
						)}
					</Panel>
				}
			>
				{(data) => <RunsBody runs={data.runs} />}
			</QueryView>
		</Page>
	);
}

function RunsBody({ runs }: { runs: RunListItem[] }) {
	const live = runs.filter((r) => r.status === "running");
	const history = runs.filter((r) => r.status !== "running");
	const now = useNow(live.length > 0);
	return (
		<>
			{live.length > 0 && (
				<section aria-label="进行中">
					<SectionHeading level={2}>
						进行中 <span className="font-mono text-fg-3">{live.length}</span>
					</SectionHeading>
					<div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] gap-3">
						{live.map((run) => (
							<RunCard key={run.id} run={run} now={now} />
						))}
					</div>
				</section>
			)}
			{history.length > 0 && (
				<section aria-label="历史运行">
					<SectionHeading level={2}>
						历史运行 <span className="font-mono text-fg-3">{history.length}</span>
					</SectionHeading>
					<Panel>
						<RunHistoryTable runs={history} now={now} />
					</Panel>
				</section>
			)}
		</>
	);
}

function Toolbar({ counts }: { counts?: Record<(typeof STATUSES)[number], number> }) {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const update = (patch: Partial<z.infer<typeof RunsSearch>>) =>
		void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

	// 与命令面板共用同一个缓存（默认列表：没有归档的场景）；已归档的场景单独列出，历史运行仍可回看。
	const scenarios = useQuery(apiQuery(orchestrationsApi.list, { query: {} }));
	const archived = useQuery(apiQuery(orchestrationsApi.list, { query: { archived: "true" } }));

	const searchBox = useSearchInput(search.q, (q) => update({ q }));

	const withCount = (label: string, n: number | undefined) => (n ? `${label} ${n}` : label);
	return (
		<div className="mb-3.5 flex items-center gap-2">
			<Segmented<StatusFilter>
				label="状态"
				value={search.status ?? "all"}
				onChange={(value) => update({ status: value === "all" ? undefined : value })}
				options={[
					{ value: "all", label: "全部" },
					{ value: "running", label: withCount("运行中", counts?.running) },
					{ value: "failed", label: withCount("失败", counts?.failed) },
					{ value: "success", label: "成功" },
					{ value: "cancelled", label: "已取消" },
				]}
			/>
			<NativeSelect
				aria-label="场景"
				className="w-50"
				value={search.scenario ?? ""}
				onChange={(event) => update({ scenario: event.target.value || undefined })}
			>
				<option value="">全部场景</option>
				{scenarios.data?.orchestrations.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name}
					</option>
				))}
				{!!archived.data?.orchestrations.length && (
					<optgroup label={MESSAGE.archived}>
						{archived.data.orchestrations.map((o) => (
							<option key={o.id} value={o.id}>
								{o.name}（{MESSAGE.archived}）
							</option>
						))}
					</optgroup>
				)}
			</NativeSelect>
			<span className="relative inline-flex w-60">
				<SearchIcon
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-2.25 size-3.5 -translate-y-1/2 text-fg-3"
				/>
				<Input
					type="search"
					aria-label="搜索运行编号或触发人"
					placeholder="运行编号、触发人"
					className="pl-7.5"
					value={searchBox.value}
					onChange={(event) => searchBox.onChange(event.target.value)}
				/>
			</span>
		</div>
	);
}
