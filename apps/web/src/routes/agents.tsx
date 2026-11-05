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
		<div className="sf-page max-w-6xl!">
			<h1>Agent</h1>
			<p className="sf-page__sub">Agent 启动后主动连接控制面并按名称注册。</p>
			{isPending && <p className="sf-hint mt-6">加载中…</p>}
			{error && <p className="sf-err mt-6">加载失败：{error.message}</p>}
			{data && data.agents.length === 0 && <p className="sf-hint mt-6">还没有 Agent 注册过。</p>}
			{data && data.agents.length > 0 && (
				<table className="sf-table">
					<thead>
						<tr>
							<th scope="col">名称</th>
							<th scope="col">状态</th>
							<th scope="col">版本</th>
							<th scope="col">系统</th>
							<th scope="col">已安装的包</th>
							<th scope="col">正在运行的任务</th>
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
		<tr>
			<td className="font-mono font-semibold">{agent.name}</td>
			<td>
				<span
					className="inline-flex items-center gap-1"
					style={{ color: online ? "var(--sf-ok)" : "var(--sf-text-3)" }}
				>
					<span className={`sf-dot ${online ? "sf-dot--on" : ""}`} />
					{online ? "在线" : "离线"}
				</span>
				<div className="sf-hint mt-0">
					{online ? "连接于" : "最后在线"} {new Date(agent.last_seen_at).toLocaleString()}
				</div>
			</td>
			<td className="font-mono">{agent.info.agent_version || "—"}</td>
			<td>
				<span className="font-mono">
					{agent.info.os || "?"}/{agent.info.arch || "?"}
				</span>
				<div className="sf-hint mt-0">{agent.info.slots} 个槽位</div>
			</td>
			<td>
				{agent.installed_packages.length === 0 ? (
					<span className="text-[var(--sf-text-3)]">无</span>
				) : (
					<ul className="font-mono text-xs">
						{agent.installed_packages.map((p) => (
							<li key={`${p.name}@${p.version}`}>
								{p.name}@{p.version}
							</li>
						))}
					</ul>
				)}
				{agent.install?.state === "installing" && (
					<div className="text-xs text-[var(--sf-warn)]">
						正在安装 {agent.install.package}@{agent.install.version}
					</div>
				)}
				{agent.install?.state === "failed" && (
					<div className="text-xs text-[var(--sf-danger-text)]">
						安装 {agent.install.package}@{agent.install.version} 失败
					</div>
				)}
				{agent.dev_packages?.length > 0 && (
					<ul className="mt-1 font-mono text-xs text-[var(--sf-accent-hi)]">
						{agent.dev_packages.map((p) => (
							<li key={p.name} className="truncate" title={p.source}>
								开发版本 {p.name}（{p.source}）
							</li>
						))}
					</ul>
				)}
			</td>
			<td>
				{agent.running_tasks.length === 0 ? (
					<span className="text-[var(--sf-text-3)]">空闲</span>
				) : (
					<ul className="space-y-1 text-xs">
						{agent.running_tasks.map((t) => (
							<li key={t.task_id}>
								<span className="font-mono">{t.node_id}</span>（第 {t.attempt} 次尝试）
								<div className="text-[var(--sf-text-3)]">
									运行 <span className="font-mono">{t.run_id.slice(0, 8)}</span> · 开始于{" "}
									{new Date(t.started_at).toLocaleTimeString()}
								</div>
							</li>
						))}
					</ul>
				)}
				<div className="sf-hint mt-0">
					{agent.running_tasks.length}/{agent.info.slots} 槽位占用
				</div>
			</td>
		</tr>
	);
}
