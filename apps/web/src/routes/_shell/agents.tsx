import { agentBinariesApi, agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ServerIcon, TerminalIcon } from "lucide-react";
import { AgentRack } from "#/agents/AgentRack";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { STATUS_POLL_MS } from "#/lib/polling";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

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
	const hasAgents = (agents.data?.agents.length ?? 0) > 0;
	const content = (
		<QueryView
			query={agents}
			loading={<TableSkeleton columns={11} />}
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
				<div className="flex flex-col gap-3.5">
					{data.agents.map((agent) => (
						<AgentRack
							key={agent.name}
							agent={agent}
							controlPlaneVersion={data.control_plane_version}
						/>
					))}
				</div>
			)}
		</QueryView>
	);
	return (
		<Page>
			<PageHeader
				title={PAGE.agents}
				count={agents.data?.agents.length}
				actions={hasAgents && <ConnectHelp command={command} />}
			/>
			{/* 每台 Agent 自己是一个面板；加载、错误、空状态放在一个面板里。 */}
			{hasAgents ? content : <Panel>{content}</Panel>}
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
						<code className="font-mono">--token &lt;令牌&gt;</code>
						。开发机、配置和自动更新见开发文档的「
						<Link
							to="/docs/$page"
							params={{ page: "install-agent" }}
							className="text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1"
						>
							安装 Agent
						</Link>
						」。
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<CodeBlock code={command} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
