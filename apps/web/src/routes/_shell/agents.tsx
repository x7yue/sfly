import { type AgentView, agentBinariesApi, agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { cn } from "cn";
import { ServerIcon, TerminalIcon } from "lucide-react";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { SlotBar, type StatusKind, StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import { STATUS_POLL_MS } from "#/lib/polling";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_shell/agents")({
	staticData: { crumb: PAGE.agents },
	component: AgentsPage,
});

/**
 * 接入命令：在测试机上运行控制面的 install.sh（ADR 0011）。地址用控制面给出的对外地址（SFLY_PUBLIC_URL），
 * 还没取到时用浏览器当前访问的地址。
 */
function useConnectCommand() {
	const binaries = useQuery(apiQuery(agentBinariesApi.list));
	const url = binaries.data?.install_script_url ?? `${window.location.origin}/install.sh`;
	return `curl -fsSL ${url} | sh -s -- --name <名称>`;
}

function AgentsPage() {
	const command = useConnectCommand();
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: STATUS_POLL_MS });
	return (
		<Page>
			<PageHeader
				title={PAGE.agents}
				count={agents.data?.agents.length}
				actions={agents.data && agents.data.agents.length > 0 && <ConnectHelp command={command} />}
			/>
			<Panel>
				<QueryView
					query={agents}
					loading={<TableSkeleton columns={8} />}
					errorTitle="无法加载 Agent"
					isEmpty={(d) => d.agents.length === 0}
					empty={
						<EmptyState
							icon={<ServerIcon />}
							title="还没有 Agent 连接"
							description="在测试机上运行下面的命令安装 Agent，它会主动连接控制面并出现在这里。首次启动会自动准备 uv、共享 venv 和 SDK 运行时。"
						>
							<CodeBlock code={command} className="mx-auto w-fit" />
						</EmptyState>
					}
				>
					{(data) => (
						<AgentTable agents={data.agents} controlPlaneVersion={data.control_plane_version} />
					)}
				</QueryView>
			</Panel>
		</Page>
	);
}

function ConnectHelp({ command }: { command: string }) {
	return (
		<Dialog>
			<DialogTrigger render={<Button variant="ghost" />}>
				<TerminalIcon />
				如何接入 Agent
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>接入 Agent</DialogTitle>
					<DialogDescription>
						在测试机上运行下面的命令：识别架构、下载并校验 Agent，写入配置并注册 systemd 服务。
						Agent 按名称注册，同名重新连接会替换旧连接。配置了注册令牌时加上{" "}
						<code className="font-mono">--token &lt;令牌&gt;</code>。
					</DialogDescription>
				</DialogHeader>
				<CodeBlock code={command} />
			</DialogContent>
		</Dialog>
	);
}

function AgentTable({
	agents,
	controlPlaneVersion,
}: {
	agents: AgentView[];
	controlPlaneVersion: string;
}) {
	return (
		<Table aria-label="Agent 列表">
			<TableHeader>
				<TableRow>
					<TableHead>名称</TableHead>
					<TableHead>状态</TableHead>
					<TableHead>槽位</TableHead>
					<TableHead>版本</TableHead>
					<TableHead>系统</TableHead>
					<TableHead>已安装的节点包</TableHead>
					<TableHead>被场景引用</TableHead>
					<TableHead>最后在线</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{agents.map((agent) => (
					<AgentRow key={agent.name} agent={agent} controlPlaneVersion={controlPlaneVersion} />
				))}
			</TableBody>
		</Table>
	);
}

/**
 * 在线 Agent 的更新状态（ADR 0014）：版本与控制面不一致时不接新任务，状态列说明它在做什么；
 * 不需要更新时为 undefined。
 */
function updateStatus(
	agent: AgentView,
): { kind: StatusKind; label: string; detail?: string } | undefined {
	const { update } = agent;
	switch (update.state) {
		case "downloading":
			return { kind: "running", label: "更新中", detail: "下载新版本" };
		case "waiting_for_tasks":
			return {
				kind: "running",
				label: "更新中",
				detail: `等待 ${update.remaining_tasks} 个任务结束`,
			};
		case "replacing":
			return { kind: "running", label: "更新中", detail: "替换并重新启动" };
		case "failed":
			return { kind: "failed", label: "更新失败", detail: update.reason };
		case "manual_upgrade_required":
			return { kind: "warn", label: "需要手动升级", detail: update.reason };
		case "none":
			return agent.version_mismatch ? { kind: "warn", label: "版本不一致" } : undefined;
	}
}

function AgentRow({
	agent,
	controlPlaneVersion,
}: {
	agent: AgentView;
	controlPlaneVersion: string;
}) {
	const online = agent.status === "online";
	const update = online ? updateStatus(agent) : undefined;
	const mismatch = online && agent.version_mismatch;
	const installing = online && agent.install?.state === "installing";
	const failed = agent.install?.state === "failed";
	const packages = [
		...agent.installed_packages.map((p) => `${p.name}@${p.version}`),
		...agent.dev_packages.map((p) => `${p.name}@dev`),
	];
	return (
		<TableRow>
			<TableCell className="font-mono font-medium">{agent.name}</TableCell>
			<TableCell>
				{update ? (
					<StatusPill kind={update.kind}>{update.label}</StatusPill>
				) : installing ? (
					<StatusPill kind="warn">安装中</StatusPill>
				) : online ? (
					<StatusPill kind="ok">在线</StatusPill>
				) : (
					<StatusPill kind="pending">离线</StatusPill>
				)}
				{update?.detail && (
					<div
						className={cn(
							"max-w-60 text-2xs",
							update.kind === "failed" ? "text-danger-fg" : "text-fg-3",
						)}
					>
						{update.detail}
					</div>
				)}
				{!update && installing && agent.install && (
					<div className="font-mono text-2xs text-fg-3">
						{agent.install.package}@{agent.install.version}
					</div>
				)}
				{failed && agent.install && (
					<div className="text-2xs text-danger-fg">
						安装 {agent.install.package}@{agent.install.version} 失败
					</div>
				)}
			</TableCell>
			<TableCell>
				<SlotBar used={agent.running_tasks.length} total={agent.info.slots} />
			</TableCell>
			<TableCell className="font-mono">
				{agent.info.agent_version || "—"}
				{mismatch && <div className="text-2xs text-fg-3">控制面 {controlPlaneVersion}</div>}
			</TableCell>
			<TableCell className="font-mono text-xs text-fg-2">
				{agent.info.os || "?"}/{agent.info.arch || "?"}
			</TableCell>
			<TableCell className="max-w-80 font-mono text-xs text-fg-2">
				{packages.length === 0 ? <span className="text-fg-3">无</span> : packages.join("、")}
			</TableCell>
			<TableCell className="text-xs text-fg-2">
				{agent.referencing_orchestrations > 0 ? (
					`${agent.referencing_orchestrations} 个场景`
				) : (
					<span className="text-fg-3">未被引用</span>
				)}
			</TableCell>
			<TableCell className="font-mono text-xs text-fg-3">
				{online ? "—" : formatDateTime(agent.last_seen_at)}
			</TableCell>
		</TableRow>
	);
}
