import { agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon, ServerIcon, TerminalIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AgentRack } from "#/agents/AgentRack";
import { useConnectCommand } from "#/agents/connect-command";
import { CredentialsDialog } from "#/agents/credentials/CredentialsDialog";
import { useCanAdminAgents } from "#/agents/use-agent-admin";
import { useSlotFocus } from "#/agents/use-slot-focus";
import { DocPageLink } from "#/components/doc-page-link";
import { EmptyState, QueryView, RackSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { AGENT_ADMIN, MESSAGE, PAGE, TERM } from "#/lib/copy";
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
	const canAdmin = useCanAdminAgents();
	const command = useConnectCommand();
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: STATUS_POLL_MS });
	const runFocus = useSlotFocus(agents.data?.agents ?? []);
	const hasAgents = (agents.data?.agents.length ?? 0) > 0;
	const loading = agents.data === undefined && !agents.isError;
	const content = (
		<QueryView
			query={agents}
			loading={<RackSkeleton />}
			errorTitle={MESSAGE.loadFailed(TERM.agent)}
			isEmpty={(d) => d.agents.length === 0}
			empty={
				<EmptyState
					icon={<ServerIcon />}
					title={MESSAGE.noAgents}
					description={
						(canAdmin
							? "每台 Agent 用自己的凭据连接：先点页头的「为新 Agent 签发凭据」，弹窗里有写好名字的安装命令；"
							: `每台 Agent 用自己的凭据连接：${AGENT_ADMIN.askAdmin}，拿到凭据之后，`) +
						"在测试机上运行下面的命令，Agent 会主动连接控制面并出现在这里。首次启动会自动准备 uv、共享 venv 和 SDK 运行时。下面是命令的样子（名称换成签发凭据时的名字，凭据在命令运行之后粘贴）。"
					}
				>
					<CodeBlock code={command} wrap="mono" className="mx-auto max-w-3xl" />
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
				actions={
					<>
						<IssueForNewAgent />
						{hasAgents && <ConnectHelp command={command} canAdmin={canAdmin} />}
					</>
				}
			/>
			{/* 每台 Agent 自己是一个面板，加载骨架也是一台一个面板；只有错误和空状态放进一个面板。 */}
			{hasAgents || loading ? content : <Panel>{content}</Panel>}
		</Page>
	);
}

/** 页头的「为新 Agent 签发凭据」：还没连过的名字先签发，弹窗里有写好名字的安装命令。只有能管理的人看得到。 */
function IssueForNewAgent() {
	const canAdmin = useCanAdminAgents();
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	if (!canAdmin) return null;
	return (
		<>
			<Button ref={button} variant="primary" onClick={() => setOpen(true)}>
				<KeyRoundIcon />
				为新 Agent 签发凭据
			</Button>
			<CredentialsDialog name={null} open={open} onOpenChange={setOpen} returnFocus={button} />
		</>
	);
}

function ConnectHelp({ command, canAdmin }: { command: string; canAdmin: boolean }) {
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
						Agent 按名称注册，同名重新连接会替换旧连接。每台 Agent 用自己的凭据连接：
						{canAdmin
							? "先在这个页面按台签发，已经连上过的 Agent 点它面板上的「凭据」，还没连过的点页头的「为新 Agent 签发凭据」，签发之后弹窗里的命令已经写好了名字。"
							: `${AGENT_ADMIN.askAdmin}，签发之后命令里的名字要和凭据的名字一致。`}
						凭据经环境变量 <code className="font-mono">SFLY_TOKEN</code>{" "}
						传给安装命令：命令运行之后在提示处粘贴凭据（<code className="font-mono">read -rs</code>
						，输入不显示，也不放在命令行参数里）。开发机、配置和自动更新见开发文档的「
						<DocPageLink page="install-agent" />
						」。
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<CodeBlock code={command} wrap="mono" />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
