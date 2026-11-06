import { type AgentView, agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServerIcon, TerminalIcon } from "lucide-react";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { SlotBar, StatusPill } from "#/components/status";
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

/** Agent 默认连接的 gRPC 端口（控制面 SFLY_GRPC_PORT 的默认值）。 */
const DEFAULT_GRPC_PORT = 50051;

/** 接入命令：控制面地址取浏览器当前访问的主机名 + 默认 gRPC 端口。 */
const connectCommand = () =>
	[
		"sfly-agent --name <名称> \\",
		`  --server http://${window.location.hostname}:${DEFAULT_GRPC_PORT} \\`,
		"  --slots 4",
	].join("\n");

function AgentsPage() {
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: STATUS_POLL_MS });
	return (
		<Page>
			<PageHeader
				title={PAGE.agents}
				count={agents.data?.agents.length}
				actions={agents.data && agents.data.agents.length > 0 && <ConnectHelp />}
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
							description="在测试机上启动 Agent，它会主动连接控制面并出现在这里。首次启动会自动创建共享 venv 并安装 SDK 运行时。"
						>
							<CodeBlock code={connectCommand()} className="mx-auto w-fit" />
						</EmptyState>
					}
				>
					{(data) => <AgentTable agents={data.agents} />}
				</QueryView>
			</Panel>
		</Page>
	);
}

function ConnectHelp() {
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
						在测试机上安装 uv 后运行下面的命令；Agent 按名称注册，同名重新连接会替换旧连接。
						配置了注册令牌时加上 <code className="font-mono">--token</code>。
					</DialogDescription>
				</DialogHeader>
				<CodeBlock code={connectCommand()} />
			</DialogContent>
		</Dialog>
	);
}

function AgentTable({ agents }: { agents: AgentView[] }) {
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
					<AgentRow key={agent.name} agent={agent} />
				))}
			</TableBody>
		</Table>
	);
}

function AgentRow({ agent }: { agent: AgentView }) {
	const online = agent.status === "online";
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
				{installing ? (
					<StatusPill kind="warn">安装中</StatusPill>
				) : online ? (
					<StatusPill kind="ok">在线</StatusPill>
				) : (
					<StatusPill kind="pending">离线</StatusPill>
				)}
				{installing && agent.install && (
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
			<TableCell className="font-mono">{agent.info.agent_version || "—"}</TableCell>
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
