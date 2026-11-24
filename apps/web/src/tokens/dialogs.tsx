import {
	domainKey,
	type IssuedToken,
	SCOPE_LABELS,
	SCOPES,
	type Scope,
	TOKEN_NAME_MAX_LENGTH,
	type TokenView,
	tokensApi,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { writeClipboard } from "#/components/feedback/clipboard";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import {
	MESSAGE,
	scopesText,
	TOKEN_DEFAULT_EXPIRY,
	TOKEN_EXPIRY_OPTIONS,
	TOKEN_SCOPE_HELP,
} from "#/lib/copy";
import { errorText } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";

/**
 * 令牌的弹窗（ADR 0029「凭据」）：签发（成功后只显示这一次原值）、吊销确认。
 * 个人令牌和项目令牌共用同一套：区别只在项目令牌不能带「管理」范围、范围必选，个人令牌可以限定项目。
 */

/** 令牌属于谁：自己（个人令牌，不带项目）或一个项目（项目令牌，用路径里的项目）。 */
export type TokenOwner = { kind: "personal" } | { kind: "project"; project: string };

/** 令牌相关的查询（个人的和项目的）全部重新获取。 */
export function useInvalidateTokens() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: domainKey(tokensApi.listPersonal) });
}

/** 项目令牌自己不能带「管理」：成员和角色的管理只能由人做（控制面也会拒绝，这里不给选）。 */
const PROJECT_TOKEN_SCOPES: readonly Scope[] = SCOPES.filter((scope) => scope !== "manage");

/** 项目标识的写法（和控制面一致）：小写字母、数字、连字符，不以连字符开头。 */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 签发令牌：名称、范围、（个人令牌）限定项目、有效期。成功后同一个弹窗里显示原值，关掉就再也看不到。 */
export function IssueTokenDialog({
	owner,
	open,
	onOpenChange,
	returnFocus,
}: {
	owner: TokenOwner;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 关掉之后焦点回到的元素（Esc、取消、完成都一样）；不写时落到页面上。 */
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const project = owner.kind === "project";
	const [name, setName] = useState("");
	// 个人令牌：不勾「只要部分范围」就是签发人此刻能有的全部范围（接口不写 scopes）；项目令牌的范围必须选。
	const [partial, setPartial] = useState(false);
	const [scopes, setScopes] = useState<Scope[]>(["read"]);
	const [limitProject, setLimitProject] = useState("");
	const [expiry, setExpiry] = useState<string>(TOKEN_DEFAULT_EXPIRY);
	const [submitted, setSubmitted] = useState(false);
	const [issued, setIssued] = useState<IssuedToken | null>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const projectInput = useRef<HTMLInputElement>(null);
	const scopeList = useRef<HTMLUListElement>(null);
	const invalidate = useInvalidateTokens();
	const issue = useMutation({
		mutationFn: (body: {
			name: string;
			scopes?: Scope[];
			project?: string;
			expires_in_days?: number;
		}) =>
			owner.kind === "personal"
				? callApi(tokensApi.issuePersonal, { body })
				: callApi(tokensApi.issueProject, {
						params: { project: owner.project },
						body: { ...body, scopes: body.scopes ?? [] },
					}),
		onSuccess: async (created) => {
			setIssued(created);
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) {
			setName("");
			setPartial(false);
			setScopes(["read"]);
			setLimitProject("");
			setExpiry(TOKEN_DEFAULT_EXPIRY);
			setSubmitted(false);
			setIssued(null);
			issue.reset();
		}
	}, [open, issue.reset]);

	const chooseScopes = project || partial;
	const problems = {
		name:
			name.trim() === ""
				? "填写令牌的名称"
				: name.trim().length > TOKEN_NAME_MAX_LENGTH
					? `令牌的名称不能超过 ${TOKEN_NAME_MAX_LENGTH} 个字符`
					: undefined,
		scopes: chooseScopes && scopes.length === 0 ? "至少选一个范围" : undefined,
		project:
			!project && limitProject.trim() !== "" && !PROJECT_ID.test(limitProject.trim())
				? "项目标识只能用小写字母、数字和连字符"
				: undefined,
	};
	// 提交过一次、上面还标着问题时「签发」不可用（改好之后恢复）：报着错的时候它看起来不该能点。
	const blocked = submitted && Object.values(problems).some((problem) => problem !== undefined);
	const choices = project ? PROJECT_TOKEN_SCOPES : SCOPES;
	const toggle = (scope: Scope, checked: boolean) =>
		setScopes((current) =>
			checked
				? [...current, scope].filter((s, i, all) => all.indexOf(s) === i)
				: current.filter((s) => s !== scope),
		);

	const submit = () => {
		setSubmitted(true);
		if (problems.name) return nameInput.current?.focus();
		// 范围有问题时焦点放到第一个勾选框（和名称、限定项目一样）：提交之后「签发」随即不可用，焦点还留在它上面的话会落到页面上。
		if (problems.scopes) return scopeList.current?.querySelector("input")?.focus();
		if (problems.project) return projectInput.current?.focus();
		const days = TOKEN_EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days ?? null;
		issue.mutate({
			name: name.trim(),
			// 按固定顺序传，不按勾选的先后。
			...(chooseScopes ? { scopes: SCOPES.filter((scope) => scopes.includes(scope)) } : {}),
			...(!project && limitProject.trim() !== "" ? { project: limitProject.trim() } : {}),
			...(days === null ? {} : { expires_in_days: days }),
		});
	};

	return (
		<Dialog
			open={open}
			// 原值只显示这一次：显示它的时候点遮罩、按 Esc 都不关，只能点「我已保存，完成」。
			pointerDismiss={issued ? "never" : "pristine"}
			onOpenChange={(next, details) => {
				// 显示原值的时候，Esc、点遮罩（pointerDismiss 已经挡了）、关闭按钮（也没有渲染）都不关。
				if (!next && issued) {
					details.cancel();
					return;
				}
				onOpenChange(next);
			}}
		>
			{/* 显示原值的时候没有右上角的关闭按钮：和 Esc、点遮罩一样，只能点「我已保存，完成」关掉，免得手滑把只显示一次的原值丢了。 */}
			<DialogContent showCloseButton={!issued} finalFocus={returnFocus}>
				{issued ? (
					<IssuedView issued={issued} onDone={() => onOpenChange(false)} />
				) : (
					<form
						noValidate
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<DialogHeader>
							<DialogTitle>{project ? "签发项目令牌" : "签发个人令牌"}</DialogTitle>
							<DialogDescription>
								{project
									? "项目令牌属于这个项目（服务账号），给自动化和自建页面用。令牌的原值只显示一次。"
									: "个人令牌属于你，命令行、API 客户端和自建页面用它代表你。令牌的原值只显示一次。"}
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<FormField
								label="名称"
								required
								error={submitted ? problems.name : undefined}
								help="用这个令牌触发的运行、保存的版本上会写「经 名称」，让人看得出是哪个令牌做的：起个认得出是哪一个的名字。"
							>
								{(control) => (
									<Input
										{...control}
										ref={nameInput}
										value={name}
										onChange={(e) => setName(e.target.value)}
										maxLength={TOKEN_NAME_MAX_LENGTH}
										autoComplete="off"
										autoFocus
									/>
								)}
							</FormField>
							<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
								<legend className="mb-1 p-0 text-xs text-fg-2">
									范围
									{project && (
										<span aria-hidden className="ml-0.5 text-fg-3">
											*
										</span>
									)}
								</legend>
								{!project && (
									<Segmented
										label="范围的选法"
										value={partial ? "some" : "all"}
										onChange={(value) => setPartial(value === "some")}
										options={[
											{ value: "all", label: "全部范围" },
											{ value: "some", label: "只选一部分" },
										]}
										className="self-start"
									/>
								)}
								{!chooseScopes && (
									<p className="m-0 text-xs text-fg-3">
										你此刻能有的全部范围；使用时还会和你当时的角色取交集。
									</p>
								)}
								{!project && chooseScopes && (
									<p className="m-0 text-xs text-fg-3">只有勾上的范围；令牌不能做勾选之外的事。</p>
								)}
								{chooseScopes && (
									<ul
										ref={scopeList}
										className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-2 p-0"
									>
										{choices.map((scope) => (
											<li key={scope}>
												<CheckRow
													checked={scopes.includes(scope)}
													onChange={(checked) => toggle(scope, checked)}
												>
													<span className="flex flex-col">
														<span>{SCOPE_LABELS[scope]}</span>
														<span className="text-xs text-fg-3">{TOKEN_SCOPE_HELP[scope]}</span>
													</span>
												</CheckRow>
											</li>
										))}
									</ul>
								)}
								{submitted && problems.scopes && (
									<p role="alert" className="m-0 text-xs text-danger-fg">
										{problems.scopes}
									</p>
								)}
								{project && (
									<p className="m-0 text-xs text-fg-3">
										项目令牌不能带「{SCOPE_LABELS.manage}」范围：成员和角色的管理只能由人做。
									</p>
								)}
							</fieldset>
							{!project && (
								<FormField
									label="限定项目"
									error={submitted ? problems.project : undefined}
									help="不填就不限定；填了，这个令牌只能用在这个项目里。"
								>
									{(control) => (
										<Input
											{...control}
											ref={projectInput}
											value={limitProject}
											onChange={(e) => setLimitProject(e.target.value)}
											placeholder="不限定"
											autoComplete="off"
											spellCheck={false}
											className="font-mono"
										/>
									)}
								</FormField>
							)}
							<FormField label="有效期" help="到期后令牌自动失效；也可以随时吊销。">
								{(control) => (
									<NativeSelect
										{...control}
										value={expiry}
										onChange={(e) => setExpiry(e.target.value)}
									>
										{TOKEN_EXPIRY_OPTIONS.map((option) => (
											<NativeSelectOption key={option.value} value={option.value}>
												{option.label}
											</NativeSelectOption>
										))}
									</NativeSelect>
								)}
							</FormField>
							{issue.isError && <FormAlert>{errorText(issue.error)}</FormAlert>}
						</DialogBody>
						<DialogFooter>
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								取消
							</Button>
							<Button
								type="submit"
								variant="primary"
								disabled={issue.isPending || blocked}
								title={blocked ? "先改正上面标出的问题" : undefined}
							>
								签发
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** 一行勾选：点文字也能切换，勾选框的名称是这一行的文字。 */
function CheckRow({
	checked,
	onChange,
	children,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	children: React.ReactNode;
}) {
	const id = useId();
	return (
		<label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm">
			<Checkbox
				id={id}
				className="mt-0.5"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{children}
		</label>
	);
}

/** 刚签发的令牌：原值只在这里出现一次，关掉就读不回；复制按钮在点击里同步写剪贴板。 */
function IssuedView({ issued, onDone }: { issued: IssuedToken; onDone: () => void }) {
	return (
		<>
			<DialogHeader>
				<DialogTitle>令牌「{issued.name}」已签发</DialogTitle>
				<DialogDescription>
					现在就复制并保存好：这是令牌的原值，只显示这一次，关掉之后任何地方都看不到了，丢了只能吊销重签。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<div className="flex items-center gap-2">
					<Input
						readOnly
						aria-label="令牌原值"
						value={issued.token}
						className="font-mono text-xs"
						data-issued-token=""
						onFocus={(e) => e.currentTarget.select()}
						autoFocus
					/>
					<Button
						onClick={() =>
							writeClipboard(
								issued.token,
								() => notify.success(MESSAGE.copied),
								"可以手动选中上面的令牌复制",
							)
						}
					>
						<CopyIcon />
						复制
					</Button>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="primary" onClick={onDone}>
					我已保存，完成
				</Button>
			</DialogFooter>
		</>
	);
}

/** 吊销确认：立即失效，不能撤销。 */
export function RevokeTokenDialog({
	owner,
	token,
	open,
	onOpenChange,
}: {
	owner: TokenOwner;
	token: TokenView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const invalidate = useInvalidateTokens();
	const revoke = useMutation({
		mutationFn: () =>
			owner.kind === "personal"
				? callApi(tokensApi.revokePersonal, { params: { id: token.id } })
				: callApi(tokensApi.revokeProject, { params: { project: owner.project, id: token.id } }),
		onSuccess: async () => {
			onOpenChange(false);
			notify.success(`已吊销令牌「${token.name}」`);
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) revoke.reset();
	}, [open, revoke.reset]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>吊销令牌「{token.name}」？</DialogTitle>
					<DialogDescription>
						吊销后令牌立即失效，用它打开的事件流也会关闭；不能撤销，要再用只能重新签发。
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<p className="m-0 text-xs text-fg-3">
						前缀{" "}
						<span data-slot="token-prefix" className="font-mono text-fg-2">
							{token.prefix}…
						</span>
						，范围 {scopesText(token.scopes)}
					</p>
					{revoke.isError && <FormAlert>吊销失败：{errorText(revoke.error)}</FormAlert>}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
						吊销
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
