import { agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServerIcon, TerminalIcon } from "lucide-react";
import { AgentRack } from "#/agents/AgentRack";
import { useConnectCommand } from "#/agents/connect-command";
import { useSlotFocus } from "#/agents/use-slot-focus";
import { DocPageLink } from "#/components/doc-page-link";
import { EmptyState, QueryView, RackSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { MESSAGE, PAGE } from "#/lib/copy";
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

function AgentsPage() {
	const command = useConnectCommand();
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: STATUS_POLL_MS });
	const runFocus = useSlotFocus(agents.data?.agents ?? []);
	const hasAgents = (agents.data?.agents.length ?? 0) > 0;
	const loading = agents.data === undefined && !agents.isError;
	const content = (
		<QueryView
			query={agents}
			loading={<RackSkeleton />}
			errorTitle="无法加载 Agent"
			isEmpty={(d) => d.agents.length === 0}
			empty={
				<EmptyState
					icon={<ServerIcon />}
					title={MESSAGE.noAgents}
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
							runFocus={runFocus}
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
			{/* 每台 Agent 自己是一个面板，加载骨架也是一台一个面板；只有错误和空状态放进一个面板。 */}
			{hasAgents || loading ? content : <Panel>{content}</Panel>}
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
						<DocPageLink page="install-agent">安装 Agent</DocPageLink>
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
