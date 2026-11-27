import {
	type AgentView,
	agentsApi,
	dashboardApi,
	domainKey,
	orchestrationsApi,
	runsApi,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdminErrorText } from "#/agents/admin-error";
import { CredentialsDialog } from "#/agents/credentials/CredentialsDialog";
import { useCanAdminAgents } from "#/agents/use-agent-admin";
import { notify } from "#/components/feedback/notify";
import { UntrustedText } from "#/components/untrusted-text";
import { callApi } from "#/lib/api";
import { AGENT_DISABLE } from "#/lib/copy";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-field";

/**
 * 一台 Agent 的管理操作（机架头部右侧，只有能管理的人看得到，`useCanAdminAgents`）：「凭据」打开凭据弹窗；
 * 「停用」（停用中的是「恢复」）要二次确认：停用会断开连接、手上的任务按失联处理，而且停不下那台机器上正在跑的任务，确认框里写准。
 */
export function AgentAdminActions({ agent }: { agent: AgentView }) {
	const canAdmin = useCanAdminAgents();
	const [credentials, setCredentials] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const credentialsButton = useRef<HTMLButtonElement>(null);
	const toggleButton = useRef<HTMLButtonElement>(null);
	if (!canAdmin) return null;
	const disabled = agent.disabled_at !== null;
	return (
		<>
			<Button
				ref={credentialsButton}
				size="sm"
				aria-label={`${untrustedPlain(agent.name)} 的凭据`}
				onClick={() => setCredentials(true)}
			>
				<KeyRoundIcon />
				凭据
			</Button>
			<Button
				ref={toggleButton}
				size="sm"
				aria-label={`${disabled ? "恢复" : "停用"} ${untrustedPlain(agent.name)}`}
				onClick={() => setConfirming(true)}
			>
				{disabled ? AGENT_DISABLE.enable.title : AGENT_DISABLE.disable.title}
			</Button>
			<CredentialsDialog
				name={agent.name}
				open={credentials}
				onOpenChange={setCredentials}
				returnFocus={credentialsButton}
			/>
			<DisableDialog
				agent={agent}
				open={confirming}
				onOpenChange={setConfirming}
				returnFocus={toggleButton}
			/>
		</>
	);
}

/** 停用和恢复之后，Agent 列表、它手上任务所在的运行、场景的预检、控制台都变了。 */
function useInvalidateAfterToggle() {
	const queryClient = useQueryClient();
	return () => {
		for (const key of [
			domainKey(agentsApi.list),
			domainKey(runsApi.get),
			domainKey(orchestrationsApi.list),
			domainKey(dashboardApi.get),
		]) {
			void queryClient.invalidateQueries({ queryKey: key });
		}
	};
}

/** 停用或恢复的确认框（按这台 Agent 现在是不是停用的，写停用或恢复）。 */
function DisableDialog({
	agent,
	open,
	onOpenChange,
	returnFocus,
}: {
	agent: AgentView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus: React.RefObject<HTMLElement | null>;
}) {
	const disabled = agent.disabled_at !== null;
	const invalidate = useInvalidateAfterToggle();
	const toggle = useMutation({
		mutationFn: () =>
			callApi(disabled ? agentsApi.enable : agentsApi.disable, { params: { name: agent.name } }),
		onSuccess: () => {
			invalidate();
			onOpenChange(false);
			notify.success(`${disabled ? "已恢复" : "已停用"} ${untrustedPlain(agent.name)}`);
		},
	});
	useEffect(() => {
		if (open) toggle.reset();
	}, [open, toggle.reset]);
	const running = agent.running_tasks.length;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[520px]" finalFocus={returnFocus}>
				<DialogHeader>
					<DialogTitle>
						{disabled ? AGENT_DISABLE.enable.title : AGENT_DISABLE.disable.title}{" "}
						<span className="font-mono">
							<UntrustedText text={agent.name} />
						</span>
						？
					</DialogTitle>
					<DialogDescription>
						{disabled ? AGENT_DISABLE.enable.effect : AGENT_DISABLE.disable.effect}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{disabled ? (
						<p className="m-0 text-sm text-fg-2">{AGENT_DISABLE.enable.compromised}</p>
					) : (
						<ul
							aria-label="停用的后果"
							className="m-0 flex list-none flex-col gap-2 p-0 text-sm text-fg-2"
						>
							<li data-slot="disable-running">
								{running > 0 ? AGENT_DISABLE.disable.running(running) : AGENT_DISABLE.disable.idle}
							</li>
							<li data-slot="disable-task-credentials">{AGENT_DISABLE.disable.taskCredentials}</li>
							{agent.queued_tasks.length > 0 && (
								<li data-slot="disable-queued">
									{AGENT_DISABLE.disable.queued(agent.queued_tasks.length)}
								</li>
							)}
							{agent.referencing_orchestrations > 0 && (
								<li>{AGENT_DISABLE.disable.referenced(agent.referencing_orchestrations)}</li>
							)}
							<li data-slot="disable-not-stopped" className="text-warn-fg">
								{AGENT_DISABLE.disable.notStopped}
							</li>
						</ul>
					)}
					{toggle.isError && (
						<FormAlert>
							{disabled ? "恢复" : "停用"}失败：
							<AdminErrorText error={toggle.error} />
						</FormAlert>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						variant={disabled ? "primary" : "danger-solid"}
						disabled={toggle.isPending}
						onClick={() => toggle.mutate()}
					>
						{disabled ? AGENT_DISABLE.enable.title : AGENT_DISABLE.disable.title}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
