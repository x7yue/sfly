import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type AgentView, listAgents } from "#/lib/api";

export const Route = createFileRoute("/agents")({ component: AgentsPage });

function AgentsPage() {
	const { data, error, isPending } = useQuery({
		queryKey: ["agents"],
		queryFn: listAgents,
		refetchInterval: 5_000,
	});

	return (
		<div className="mx-auto max-w-6xl p-8">
			<h1 className="text-2xl font-bold">Agent</h1>
			<p className="mt-1 text-sm text-gray-500">Agent 启动后主动连接控制面并按名称注册。</p>
			{isPending && <p className="mt-6 text-gray-500">加载中…</p>}
			{error && <p className="mt-6 text-red-600">加载失败：{error.message}</p>}
			{data && data.agents.length === 0 && (
				<p className="mt-6 text-gray-500">还没有 Agent 注册过。</p>
			)}
			{data && data.agents.length > 0 && (
				<table className="mt-6 w-full text-left text-sm">
					<thead className="text-gray-500">
						<tr>
							<th className="py-2 font-normal">名称</th>
							<th className="py-2 font-normal">状态</th>
							<th className="py-2 font-normal">版本</th>
							<th className="py-2 font-normal">系统</th>
							<th className="py-2 font-normal">已安装的包</th>
							<th className="py-2 font-normal">正在运行的任务</th>
						</tr>
					</thead>
					<tbody>
						{data.agents.map((agent) => (
							<AgentRow key={agent.name} agent={agent} />
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

function AgentRow({ agent }: { agent: AgentView }) {
	const online = agent.status === "online";
	return (
		<tr className="border-t border-gray-100 align-top">
			<td className="py-2 font-mono font-semibold">{agent.name}</td>
			<td className="py-2">
				<span
					className={`inline-flex items-center gap-1 ${online ? "text-emerald-700" : "text-gray-500"}`}
				>
					<span
						className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-gray-400"}`}
					/>
					{online ? "在线" : "离线"}
				</span>
				<div className="text-xs text-gray-500">
					{online ? "连接于" : "最后在线"} {new Date(agent.last_seen_at).toLocaleString()}
				</div>
			</td>
			<td className="py-2 font-mono">{agent.info.agent_version || "—"}</td>
			<td className="py-2">
				<span className="font-mono">
					{agent.info.os || "?"}/{agent.info.arch || "?"}
				</span>
				<div className="text-xs text-gray-500">{agent.info.slots} 个槽位</div>
			</td>
			<td className="py-2">
				{agent.installed_packages.length === 0 ? (
					<span className="text-gray-400">无</span>
				) : (
					<ul className="font-mono text-xs">
						{agent.installed_packages.map((p) => (
							<li key={`${p.name}@${p.version}`}>
								{p.name}@{p.version}
							</li>
						))}
					</ul>
				)}
			</td>
			<td className="py-2">
				{agent.running_tasks.length === 0 ? (
					<span className="text-gray-400">空闲</span>
				) : (
					<ul className="space-y-1 text-xs">
						{agent.running_tasks.map((t) => (
							<li key={t.task_id}>
								<span className="font-mono">{t.node_id}</span>（第 {t.attempt} 次尝试）
								<div className="text-gray-500">
									运行 <span className="font-mono">{t.run_id.slice(0, 8)}</span> · 开始于{" "}
									{new Date(t.started_at).toLocaleTimeString()}
								</div>
							</li>
						))}
					</ul>
				)}
				<div className="text-xs text-gray-500">
					{agent.running_tasks.length}/{agent.info.slots} 槽位占用
				</div>
			</td>
		</tr>
	);
}
