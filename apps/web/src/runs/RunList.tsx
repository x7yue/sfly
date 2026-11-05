import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { getOrchestration } from "#/lib/api";
import { listRuns } from "./api";
import { durationBetween, formatTime, shortId } from "./format";
import { RunPill, useNow } from "./RunPage";

/** 运行记录（原型的 runs 表）：触发人、开始时间、耗时、状态；点击一行打开运行视图。 */
export function RunList({ orchestrationId }: { orchestrationId: string }) {
	const navigate = useNavigate();
	const orchestration = useQuery({
		queryKey: ["orchestration", orchestrationId],
		queryFn: () => getOrchestration(orchestrationId),
	});
	const runs = useQuery({
		queryKey: ["orchestration", orchestrationId, "runs"],
		queryFn: () => listRuns(orchestrationId),
		// 有运行中的运行时定时刷新列表（状态和耗时）。
		refetchInterval: (query) =>
			query.state.data?.runs.some((r) => r.status === "running") ? 3000 : false,
	});
	const list = runs.data?.runs ?? [];
	const now = useNow(list.some((r) => r.status === "running"));
	const open = (id: string) => navigate({ to: "/runs/$id", params: { id } });

	return (
		<div className="sf-editor flex h-[calc(100vh-var(--topbar-height))] flex-col">
			<header className="sf-topbar">
				<Link to="/orchestrations/$id" params={{ id: orchestrationId }} className="sf-link text-xs">
					← 编辑
				</Link>
				<h1>{orchestration.data?.name ?? "编排"} · 运行记录</h1>
				<span className="sf-tag">
					<b>{list.length}</b> 次
				</span>
			</header>
			<div className="min-h-0 flex-1 overflow-auto p-6">
				<div className="sf-runs">
					{runs.error && <p className="sf-err p-4">加载失败：{runs.error.message}</p>}
					{runs.isPending && <p className="sf-hint p-4">加载中…</p>}
					{runs.data && list.length === 0 && (
						<p className="sf-hint p-4">还没有运行过。在编辑页点击「触发运行」。</p>
					)}
					{list.length > 0 && (
						<table>
							<thead>
								<tr>
									<th scope="col">运行</th>
									<th scope="col">版本</th>
									<th scope="col">触发人</th>
									<th scope="col">开始时间</th>
									<th scope="col">耗时</th>
									<th scope="col">状态</th>
								</tr>
							</thead>
							<tbody>
								{list.map((r) => (
									<tr
										key={r.id}
										tabIndex={0}
										onClick={() => open(r.id)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												open(r.id);
											}
										}}
									>
										<td className="sf-mono" title={r.id}>
											{shortId(r.id)}
										</td>
										<td className="sf-mono">{r.orchestration_version}</td>
										<td>{r.triggered_by}</td>
										<td className="sf-mono">{formatTime(r.started_at)}</td>
										<td className="sf-mono">{durationBetween(r.started_at, r.ended_at, now)}</td>
										<td>
											<RunPill status={r.status} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>
		</div>
	);
}
