import { type AgentView, agentBinariesApi, agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ServerIcon, TerminalIcon } from "lucide-react";
import { canUpdateNow, UpdateNowButton } from "#/agents/UpdateNowButton";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel } from "#/components/page";
import { SlotBar, type StatusKind, StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { formatClockOffset, formatDateTime, formatElapsed, formatFullDateTime } from "#/lib/format";
import { STATUS_POLL_MS } from "#/lib/polling";
import { useNow } from "#/lib/use-now";
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

function AgentTable({
	agents,
	controlPlaneVersion,
}: {
	agents: AgentView[];
	controlPlaneVersion: string;
}) {
	return (
		<Table aria-label="Agent 列表" scroll="x">
			<TableHeader>
				<TableRow>
					<TableHead width="fit">名称</TableHead>
					<TableHead>状态</TableHead>
					<TableHead width="fit">槽位</TableHead>
					<TableHead width="fit">版本</TableHead>
					<TableHead width="fit">系统</TableHead>
					<TableHead width="fit">对外地址</TableHead>
					<TableHead>能力</TableHead>
					<TableHead>已安装的节点包</TableHead>
					<TableHead width="fit">被场景引用</TableHead>
					<TableHead width="fit">最后在线</TableHead>
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

/** 每项 `nowrap`：浏览器会在连字符处折行，`sfly-stub@0.1.0` 会被拆成两行。 */
function IdentifierList({ items }: { items: readonly string[] }) {
	return (
		<span className="font-mono">
			{items.map((item, i) => (
				<span key={item} className="whitespace-nowrap">
					{item}
					{i < items.length - 1 && "、"}
				</span>
			))}
		</span>
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

/** 其它 Agent 连接它用的 `地址:端口`（IPv6 地址加方括号）；没有端口（旧版本 Agent）时只有地址。 */
function endpointLabel({ address, port }: AgentView["endpoint"]): string {
	if (port === null) return address;
	return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** 准备环境中的标记：「准备环境中 · 已 2 分 10 秒」。时长按控制面时间算，每秒走一次（ADR 0018）。 */
function PreparingBadge({ since }: { since: string }) {
	const now = useNow(true);
	return (
		<div className="text-xs text-fg-2">
			准备环境中 · 已 {formatElapsed(now - new Date(since).getTime())}
		</div>
	);
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
	const preparingSince = online ? agent.preparing_since : null;
	const mismatch = online && agent.version_mismatch;
	// 时钟偏差只在达到阈值时提示（由接口判断）；离线 Agent 的偏差是断开前测的，不显示。
	const clockOffset = online && agent.clock_offset?.exceeds_threshold ? agent.clock_offset : null;
	// 能力不能被其它 Agent 调用的原因（端口被占用等）只对在线、监听端口的 Agent 提示：离线时本来就调用不了；
	// 不监听端口的旧版本 Agent 也没有能力（能力列显示「无」），不再重复说明。
	const unavailable =
		online && agent.endpoint.port !== null ? agent.endpoint.unavailable_reason : null;
	const installing = online && agent.install?.state === "installing";
	const failed = agent.install?.state === "failed";
	const packages = [
		...agent.installed_packages.map((p) => `${p.name}@${p.version}`),
		...agent.dev_packages.map((p) => `${p.name}@dev`),
	];
	return (
		<TableRow>
			<TableCell width="fit" className="font-mono font-medium">
				{agent.name}
			</TableCell>
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
				{preparingSince && <PreparingBadge since={preparingSince} />}
				{update?.detail && (
					<div
						className={cn(
							"max-w-60 text-xs whitespace-normal",
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
				{clockOffset && (
					<div
						className="text-xs text-warn-fg"
						title={`Agent 时间与控制面时间不一致，测于 ${formatFullDateTime(clockOffset.measured_at)}`}
					>
						时间比控制面{formatClockOffset(clockOffset.offset_ms)}
					</div>
				)}
				{failed && agent.install && (
					<div className="text-xs text-danger-fg">
						安装 {agent.install.package}@{agent.install.version} 失败
					</div>
				)}
				{canUpdateNow(agent) && (
					<div className="mt-1.5">
						<UpdateNowButton agent={agent} controlPlaneVersion={controlPlaneVersion} />
					</div>
				)}
			</TableCell>
			<TableCell width="fit">
				<SlotBar used={agent.running_tasks.length} total={agent.info.slots} />
			</TableCell>
			<TableCell width="fit" className="font-mono">
				{agent.info.agent_version || "—"}
				{mismatch && <div className="text-xs text-fg-3">控制面 {controlPlaneVersion}</div>}
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-2">
				{agent.info.os || "?"}/{agent.info.arch || "?"}
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-2">
				{endpointLabel(agent.endpoint) || <span className="text-fg-3">—</span>}
				{agent.endpoint.address_source === "configured" && (
					<div className="font-sans text-xs text-fg-3">安装时配置</div>
				)}
			</TableCell>
			<TableCell className="text-xs text-fg-2">
				{agent.capabilities.length === 0 ? (
					<span className="text-fg-3">无</span>
				) : (
					<IdentifierList items={agent.capabilities.map((c) => `${c.name} v${c.version}`)} />
				)}
				{unavailable && (
					<>
						<div className="text-xs whitespace-nowrap text-warn-fg">不能被其它 Agent 调用</div>
						<div className="text-xs text-fg-3">{unavailable}</div>
					</>
				)}
			</TableCell>
			<TableCell className="text-xs text-fg-2">
				{packages.length === 0 ? (
					<span className="text-fg-3">无</span>
				) : (
					<IdentifierList items={packages} />
				)}
			</TableCell>
			<TableCell width="fit" className="text-xs text-fg-2">
				{agent.referencing_orchestrations > 0 ? (
					`${agent.referencing_orchestrations} 个场景`
				) : (
					<span className="text-fg-3">未被引用</span>
				)}
			</TableCell>
			<TableCell width="fit" className={cn("text-xs text-fg-3", !online && "font-mono")}>
				{online ? "现在" : formatDateTime(agent.last_seen_at)}
			</TableCell>
		</TableRow>
	);
}
