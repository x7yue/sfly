import { type AgentCredentialView, agentsApi, domainKey } from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { CopyIcon } from "lucide-react";
import { useReducer, useRef, useState } from "react";
import { useInstallUrl } from "#/agents/connect-command";
import { agentNameProblem, installCommand } from "#/agents/credentials/credential-command";
import {
	type Flow,
	type FlowAction,
	flowReducer,
	startFlow,
} from "#/agents/credentials/credential-flow";
import { writeClipboard } from "#/components/feedback/clipboard";
import { ErrorMessage } from "#/components/feedback/error-message";
import { notify } from "#/components/feedback/notify";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock } from "#/components/page";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { apiQuery, callApi } from "#/lib/api";
import { AGENT_CREDENTIAL, MESSAGE } from "#/lib/copy";
import { formatDateTimeWithYear } from "#/lib/format";
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
import { FormAlert, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";

/**
 * 一台 Agent 的「凭据」弹窗（ADR 0029「迁移与过渡」，#492）：列出这个名字的凭据（前缀、状态、最后使用时间、所属用户，含已吊销的，
 * 不含原值）、签发（原值只显示一次）、吊销（连着的连接断开）、轮换（先签发新的、换进 `agent.env` 重启、回来吊销旧的）。
 * 页头的「为新 Agent 签发凭据」是同一个弹窗，`name` 传 null：先填名称（还没连过的名字也能签发，过同一条规则，上限 64 个字符），
 * 提交就是签发。
 *
 * **凭据的原值怎么走**（高风险，见 PR 说明）：接口响应（`callApi`，不经 TanStack Query 的缓存，也不是 mutation 的结果）→ 这个组件
 * `useReducer` 里 `issued` 一步的状态 → 弹窗里的只读输入框和「复制」按钮（写系统剪贴板）。
 * 原值不进：URL、localStorage 与 sessionStorage、通知、日志、安装命令（命令里是 `read -rs`，运行时粘贴）、列表接口的响应。
 * 清掉的时刻：点「我已保存，完成」（回到列表）；弹窗关掉、过渡动画结束（`onOpenChangeComplete`，回到起点）。显示原值的时候 Esc、点遮罩、
 * 右上角的关闭按钮都不关（`pointerDismiss="never"`），免得手滑把只显示一次的原值丢了，也免得原值在没人看的时候留在页面上。
 * 剪贴板里的那一份页面清不掉（浏览器不让清别的程序放进去的、或用户自己改过的内容）：弹窗里写明「粘贴完之后复制点别的」。
 */
export function CredentialsDialog({
	name,
	open,
	onOpenChange,
	returnFocus,
}: {
	/** 这台 Agent 的名称；null 是给还没连过的名字签发（先填名称）。 */
	name: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 关掉之后焦点回到的元素；不写时落到页面上。 */
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const [flow, dispatch] = useReducer(
		(current: Flow, action: FlowAction) => flowReducer(current, action, name),
		name,
		startFlow,
	);
	const showing = flow.view === "issued";
	return (
		<Dialog
			open={open}
			pointerDismiss={showing ? "never" : "pristine"}
			onOpenChange={(next, details) => {
				// 显示原值的时候：Esc、点遮罩都不关，只能点「我已保存，完成」。
				if (!next && showing) {
					details.cancel();
					return;
				}
				onOpenChange(next);
			}}
			// 过渡动画结束之后才清：关的时候不让内容先变成别的样子。
			onOpenChangeComplete={(isOpen) => {
				if (!isOpen) dispatch({ type: "closed" });
			}}
		>
			<DialogContent
				showCloseButton={!showing}
				finalFocus={returnFocus}
				className="w-[760px]"
				data-credential-dialog={flow.view}
			>
				{flow.view === "name" && (
					<NameStep onCancel={() => onOpenChange(false)} dispatch={dispatch} />
				)}
				{flow.view === "list" && <ListStep name={flow.name} dispatch={dispatch} />}
				{flow.view === "issued" && (
					<IssuedStep
						name={flow.name}
						credential={flow.credential}
						token={flow.token}
						onDone={() => dispatch({ type: "done" })}
					/>
				)}
				{flow.view === "revoke" && (
					<RevokeStep name={flow.name} credential={flow.credential} dispatch={dispatch} />
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * 签发一个凭据（两处用：列表里的「签发新凭据」、新名字的名称表单）：成功时把原值交给弹窗的状态。
 * 不用 `useMutation`：它的结果会在 TanStack 的 mutation 缓存里多留一份（默认 5 分钟），原值只该在弹窗的状态里。
 */
function useIssue(dispatch: React.Dispatch<FlowAction>) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const issue = async (name: string) => {
		setPending(true);
		setError(null);
		try {
			const created = await callApi(agentsApi.issueCredential, { params: { name } });
			dispatch({ type: "issued", name, credential: created.credential, token: created.token });
			void queryClient.invalidateQueries({ queryKey: domainKey(agentsApi.listCredentials) });
		} catch (caught) {
			setError(caught);
		} finally {
			setPending(false);
		}
	};
	return { issue, pending, error, clearError: () => setError(null) };
}

/** 还没连过的名字：填名称，提交就是签发。 */
function NameStep({
	onCancel,
	dispatch,
}: {
	onCancel: () => void;
	dispatch: React.Dispatch<FlowAction>;
}) {
	const [value, setValue] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const { issue, pending, error } = useIssue(dispatch);
	const problem = agentNameProblem(value);
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				setSubmitted(true);
				if (problem) return input.current?.focus();
				void issue(value);
			}}
		>
			<DialogHeader>
				<DialogTitle>为新 Agent 签发凭据</DialogTitle>
				<DialogDescription>
					还没连过控制面的名字也可以先签发：凭据只对签发时的这个名字有效，装 Agent 时 `--name`
					要和它一致。凭据的原值只显示一次。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<FormField
					label="Agent 名称"
					required
					error={submitted ? problem : undefined}
					help="场景按名称选择 Agent；名称不能有控制字符、零宽空格这类看不见的字符，最多 64 个字符。"
				>
					{(control) => (
						<Input
							{...control}
							ref={input}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					)}
				</FormField>
				{error !== null && (
					<FormAlert>
						签发失败：
						<ErrorMessage error={error} />
					</FormAlert>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onCancel}>
					取消
				</Button>
				<Button
					type="submit"
					variant="primary"
					disabled={pending || (submitted && problem !== undefined)}
					title={submitted && problem ? "先改正上面标出的问题" : undefined}
				>
					签发凭据
				</Button>
			</DialogFooter>
		</form>
	);
}

/** 这个名字的凭据：新的在前。 */
const newestFirst = (credentials: readonly AgentCredentialView[]) =>
	[...credentials].sort((a, b) => b.created_at.localeCompare(a.created_at));

function ListStep({ name, dispatch }: { name: string; dispatch: React.Dispatch<FlowAction> }) {
	const credentials = useQuery(apiQuery(agentsApi.listCredentials, { params: { name } }));
	const { issue, pending, error } = useIssue(dispatch);
	const active = credentials.data?.credentials.filter((c) => c.revoked_at === null).length ?? 0;
	return (
		<>
			<DialogHeader>
				<DialogTitle>
					<span className="font-mono">
						<UntrustedText text={name} />
					</span>{" "}
					的凭据
				</DialogTitle>
				<DialogDescription>
					每台 Agent 用自己的凭据连接控制面，凭据只对这个名字有效。列表里只有前缀、状态和使用情况，
					原值只在签发的那一次显示。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<QueryView
					query={credentials}
					loading={<TableSkeleton columns={6} />}
					errorTitle="无法加载凭据"
					isEmpty={(d) => d.credentials.length === 0}
					empty={
						<EmptyState
							title="这个名字还没有签发过凭据"
							description="签发之后，弹窗里有写好名字的安装命令。"
						/>
					}
				>
					{(data) => (
						<CredentialTable credentials={newestFirst(data.credentials)} dispatch={dispatch} />
					)}
				</QueryView>
				{active > 0 && <RotateGuide />}
				{error !== null && (
					<FormAlert>
						签发失败：
						<ErrorMessage error={error} />
					</FormAlert>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="primary" disabled={pending} onClick={() => void issue(name)}>
					签发新凭据
				</Button>
			</DialogFooter>
		</>
	);
}

/** 轮换：先签发新的，换进 agent.env 重启，确认它用新凭据连上之后回来吊销旧的。 */
function RotateGuide() {
	return (
		<section
			aria-label="轮换凭据"
			data-slot="rotate-guide"
			className="rounded-lg border border-border-soft bg-bg px-3 py-2.5 text-xs text-fg-2"
		>
			<h3 className="m-0 mb-1 text-xs font-medium text-fg-1">{AGENT_CREDENTIAL.rotate.title}</h3>
			<ol className="m-0 flex list-decimal flex-col gap-0.5 pl-4">
				{AGENT_CREDENTIAL.rotate.steps.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
		</section>
	);
}

function CredentialTable({
	credentials,
	dispatch,
}: {
	credentials: readonly AgentCredentialView[];
	dispatch: React.Dispatch<FlowAction>;
}) {
	return (
		<Table aria-label="凭据列表">
			<TableHeader>
				<TableRow>
					<TableHead width="fit">前缀</TableHead>
					<TableHead width="fit">状态</TableHead>
					<TableHead width="fit">创建时间</TableHead>
					<TableHead width="fit">最后使用</TableHead>
					<TableHead width="grow">所属用户</TableHead>
					<TableHead width="fit" className="text-right">
						操作
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{credentials.map((credential) => {
					const live = credential.revoked_at === null;
					return (
						<TableRow key={credential.id} data-credential-state={live ? "active" : "revoked"}>
							<TableCell
								width="fit"
								data-slot="credential-prefix"
								className={cn("font-mono text-xs", live ? "text-fg-1" : "text-fg-3")}
							>
								{credential.prefix}…
							</TableCell>
							<TableCell width="fit">
								<StatusPill kind={live ? "ok" : "stopped"}>
									{live ? AGENT_CREDENTIAL.state.active : AGENT_CREDENTIAL.state.revoked}
								</StatusPill>
							</TableCell>
							<TableCell width="fit" className="font-mono text-xs text-fg-3">
								{formatDateTimeWithYear(credential.created_at)}
							</TableCell>
							<TableCell width="fit" className="font-mono text-xs text-fg-3">
								{credential.last_used_at ? (
									formatDateTimeWithYear(credential.last_used_at)
								) : (
									<span className="font-sans">从未使用</span>
								)}
							</TableCell>
							<TableCell width="grow" className="text-xs text-fg-2">
								{credential.user === null ? (
									<span className="text-fg-3" title="按台签发的凭据不属于某个用户">
										—
									</span>
								) : (
									<Truncate untrusted>{credential.user}</Truncate>
								)}
							</TableCell>
							<TableCell width="fit" className="text-right">
								{/* 固定一个按钮的高度：已吊销的行和有按钮的行一样高。 */}
								<div className="flex h-7 items-center justify-end">
									{live && (
										<Button
											size="sm"
											onClick={() => dispatch({ type: "askRevoke", credential })}
											aria-label={`吊销 ${credential.prefix}…`}
										>
											吊销
										</Button>
									)}
								</div>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

/** 刚签发的凭据：原值只在这里出现一次；安装命令里没有原值（`read -rs` 运行时粘贴）。 */
function IssuedStep({
	name,
	credential,
	token,
	onDone,
}: {
	name: string;
	credential: AgentCredentialView;
	token: string;
	onDone: () => void;
}) {
	const installUrl = useInstallUrl();
	return (
		<>
			<DialogHeader>
				<DialogTitle>
					<span className="font-mono">
						<UntrustedText text={name} />
					</span>{" "}
					的凭据已签发
				</DialogTitle>
				<DialogDescription>
					现在就复制并保存好：这是凭据的原值，<strong>只显示这一次</strong>，
					关掉之后任何地方都看不到了，丢了只能吊销重签。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<div className="flex items-center gap-2">
					<Input
						readOnly
						aria-label="凭据原值"
						value={token}
						className="font-mono text-xs"
						data-issued-credential=""
						autoComplete="off"
						spellCheck={false}
						onFocus={(event) => event.currentTarget.select()}
						autoFocus
					/>
					<Button
						aria-label="复制凭据原值"
						onClick={() =>
							writeClipboard(
								token,
								() => notify.success(MESSAGE.copied),
								"可以手动选中上面的凭据复制",
							)
						}
					>
						<CopyIcon />
						复制
					</Button>
				</div>
				<p className="m-0 text-xs text-fg-3">{AGENT_CREDENTIAL.clipboardNote}</p>
				<section aria-label="装到这台 Agent 上" className="flex flex-col gap-1.5">
					<h3 className="m-0 text-xs font-medium text-fg-1">{AGENT_CREDENTIAL.install.title}</h3>
					<p className="m-0 text-xs text-fg-2">{AGENT_CREDENTIAL.install.intro}</p>
					<CodeBlock code={installCommand(installUrl, name)} />
					<p className="m-0 text-xs text-fg-3">{AGENT_CREDENTIAL.install.note}</p>
				</section>
				<section aria-label="换掉已装好的 Agent 的凭据" className="flex flex-col gap-1.5">
					<h3 className="m-0 text-xs font-medium text-fg-1">{AGENT_CREDENTIAL.replace.title}</h3>
					<ol className="m-0 flex list-decimal flex-col gap-0.5 pl-4 text-xs text-fg-2">
						{AGENT_CREDENTIAL.replace.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
				</section>
				<p className="m-0 text-xs text-fg-3">
					前缀{" "}
					<span data-slot="credential-prefix" className="font-mono text-fg-2">
						{credential.prefix}…
					</span>
					：之后在列表里按它认出这一个。
				</p>
			</DialogBody>
			<DialogFooter>
				<Button variant="primary" onClick={onDone}>
					我已保存，完成
				</Button>
			</DialogFooter>
		</>
	);
}

/** 吊销确认：立即失效，用它连着的连接断开，不能撤销。 */
function RevokeStep({
	name,
	credential,
	dispatch,
}: {
	name: string;
	credential: AgentCredentialView;
	dispatch: React.Dispatch<FlowAction>;
}) {
	const queryClient = useQueryClient();
	const credentials = useQuery(apiQuery(agentsApi.listCredentials, { params: { name } }));
	const onlyActive =
		credentials.data !== undefined &&
		credentials.data.credentials.filter((c) => c.revoked_at === null).length <= 1;
	const revoke = useMutation({
		mutationFn: () => callApi(agentsApi.revokeCredential, { params: { name, id: credential.id } }),
		onSuccess: async () => {
			notify.success(`已吊销凭据 ${credential.prefix}…`);
			await queryClient.invalidateQueries({ queryKey: domainKey(agentsApi.listCredentials) });
			dispatch({ type: "backToList" });
		},
	});
	return (
		<>
			<DialogHeader>
				<DialogTitle>
					吊销凭据{" "}
					<span data-slot="credential-prefix" className="font-mono">
						{credential.prefix}…
					</span>
					？
				</DialogTitle>
				<DialogDescription>{AGENT_CREDENTIAL.revoke.effect}</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<p className="m-0 text-xs text-fg-3">
					这台 Agent：<span className="font-mono text-fg-2">{untrustedPlain(name)}</span>
				</p>
				{onlyActive && (
					<p data-slot="revoke-only-active" className="m-0 text-sm text-warn-fg">
						{AGENT_CREDENTIAL.revoke.onlyActive}
					</p>
				)}
				{revoke.isError && (
					<FormAlert>
						吊销失败：
						<ErrorMessage error={revoke.error} />
					</FormAlert>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={() => dispatch({ type: "backToList" })}>
					取消
				</Button>
				<Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
					吊销
				</Button>
			</DialogFooter>
		</>
	);
}
