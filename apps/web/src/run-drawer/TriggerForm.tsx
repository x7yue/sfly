import {
	domainKey,
	orchestrationsApi,
	type ParamDeclView,
	type PreflightProblem,
	type RunView,
	runListApi,
	runsApi,
} from "@sfly/schema";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { AlertTriangleIcon, CheckIcon, EyeIcon, EyeOffIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ErrorState } from "#/components/feedback/states";
import { StatusPill } from "#/components/status";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { shortId } from "#/lib/format";
import { useNickname } from "#/lib/nickname";
import { writeRunView } from "#/monitor/live-run";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type CheckRow, type LocalState, type Preflight, preflightChecks } from "./checks";
import { type FieldValue, initialValues, paramsSchema, toParams } from "./trigger-form";

/** 敏感参数临时显示的时长。 */
const REVEAL_MS = 5000;

export interface TriggerOptions extends LocalState {
	/** 「前往」问题所在的节点（画布上定位，或进入画布并选中）。 */
	onLocate?: (nodeId: string) => void;
	/** 表单初始值（再次运行时为上次运行的参数；敏感参数不沿用，需要重新填写）。 */
	initialParams?: Record<string, unknown>;
}

/**
 * 运行抽屉的表单阶段（原型 drawerHTML 的 form）：已有运行中的提示、入口参数（按入口节点的声明生成，
 * TanStack Form + zod 校验）、触发前检查清单、触发人。底部的「取消」「触发运行」由 RunDrawer 渲染，
 * 通过 formId 提交。触发成功后调用 onTriggered。
 */
export function TriggerForm({
	orchestrationId,
	formId,
	options,
	onTriggered,
	onState,
}: {
	orchestrationId: string;
	formId: string;
	options: TriggerOptions;
	onTriggered: (run: RunView) => void;
	/** 表单状态（底部按钮的禁用与文案）与预检结果里的版本号（标题旁显示）。 */
	onState: (state: { canSubmit: boolean; pending: boolean; version: number | null }) => void;
}) {
	const preflight = useQuery({
		...apiQuery(runsApi.preflight, { params: { id: orchestrationId } }),
		staleTime: 0,
		gcTime: 0,
	});

	useEffect(() => {
		if (!preflight.data) onState({ canSubmit: false, pending: false, version: null });
	}, [preflight.data, onState]);

	if (preflight.error && !preflight.data) {
		return (
			<ErrorState
				title="无法完成触发前检查"
				error={preflight.error}
				onRetry={() => void preflight.refetch()}
			/>
		);
	}
	if (!preflight.data) {
		return (
			<output aria-label="正在检查" className="flex flex-col gap-3">
				<Skeleton className="h-7.5 w-full" />
				<Skeleton className="h-7.5 w-full" />
				<Skeleton className="h-24 w-full" />
			</output>
		);
	}
	return (
		<ParamsForm
			orchestrationId={orchestrationId}
			formId={formId}
			preflight={preflight.data}
			options={options}
			onTriggered={onTriggered}
			onState={onState}
		/>
	);
}

function ParamsForm({
	orchestrationId,
	formId,
	preflight,
	options,
	onTriggered,
	onState,
}: {
	orchestrationId: string;
	formId: string;
	preflight: Preflight;
	options: TriggerOptions;
	onTriggered: (run: RunView) => void;
	onState: (state: { canSubmit: boolean; pending: boolean; version: number | null }) => void;
}) {
	const queryClient = useQueryClient();
	const nickname = useNickname();
	const decls = preflight.params;
	const checks = preflightChecks(preflight, options);
	const trigger = useMutation({
		mutationFn: (params: Record<string, unknown>) =>
			callApi(runsApi.trigger, { params: { id: orchestrationId }, body: { params } }),
		onSuccess: (run) => {
			writeRunView(queryClient, run);
			// 运行列表与场景卡片上的最近运行。
			void queryClient.invalidateQueries({ queryKey: domainKey(runsApi.get) });
			void queryClient.invalidateQueries({ queryKey: domainKey(orchestrationsApi.list) });
			onTriggered(run);
		},
	});
	const formElement = useRef<HTMLFormElement>(null);
	const form = useForm({
		defaultValues: initialValues(decls, options.initialParams),
		// 第一次提交之前不打扰；提交过一次之后随输入重新校验。
		validationLogic: revalidateLogic(),
		validators: { onDynamic: paramsSchema(decls) },
		onSubmit: ({ value }) => {
			if (checks.blocked) return;
			trigger.mutate(toParams(decls, value));
		},
		// 校验没通过：把焦点放到第一个出错的字段（等错误渲染出来再找），读屏用户知道错在哪里。
		onSubmitInvalid: () => {
			requestAnimationFrame(() =>
				formElement.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
			);
		},
	});

	const blocked = checks.blocked;
	const pending = trigger.isPending;
	useEffect(() => {
		onState({ canSubmit: !blocked, pending, version: preflight.version });
	}, [blocked, pending, preflight.version, onState]);

	return (
		<form
			ref={formElement}
			id={formId}
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
		>
			<RunningNotice orchestrationId={orchestrationId} />
			<SectionTitle first>
				入口参数
				<span className="ml-auto font-normal text-fg-3">{decls.length} 个</span>
			</SectionTitle>
			{decls.length === 0 && <p className="m-0 mb-3 text-xs text-fg-3">入口节点没有声明参数。</p>}
			{/* 标签列的宽度在这里定一次，所有参数共用：输入框的左右沿对齐 */}
			<div className="mb-3 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-start gap-x-2.5 gap-y-3">
				{decls.map((p) => (
					<form.Field key={p.name} name={p.name}>
						{(field) => (
							<ParamField
								param={p}
								value={field.state.value}
								error={errorText(field.state.meta.errors)}
								onChange={(v) => field.handleChange(v)}
								onBlur={field.handleBlur}
							/>
						)}
					</form.Field>
				))}
			</div>
			<SectionTitle>触发前检查</SectionTitle>
			<ul
				aria-label="触发前检查"
				className="m-0 mb-3.5 list-none overflow-hidden rounded-lg border border-border-soft p-0"
			>
				{checks.rows.map((row) => (
					<CheckItem key={`${row.key}:${row.title}`} row={row} onLocate={options.onLocate} />
				))}
			</ul>
			{trigger.error && <TriggerError error={trigger.error} onLocate={options.onLocate} />}
			<p className="m-0 text-xs text-fg-3">
				运行使用最新保存的版本 <span className="font-mono">v{preflight.version}</span>。触发人：
				{nickname ?? "未设置昵称"}
			</p>
		</form>
	);
}

/** 字段错误：zod 的 issue（表单级 schema 分发到字段）或字符串。 */
function errorText(errors: unknown[]): string | undefined {
	const first = errors.find(Boolean);
	if (!first) return undefined;
	if (typeof first === "string") return first;
	return (first as { message?: string }).message;
}

function SectionTitle({ children, first }: { children: React.ReactNode; first?: boolean }) {
	return (
		<h3
			className={cn(
				"mb-2.5 flex items-center text-xs font-semibold tracking-wide text-fg-2",
				first ? "mt-0" : "mt-4.5",
			)}
		>
			{children}
		</h3>
	);
}

/** 该场景已有运行中的运行：提示并给出查看入口。 */
function RunningNotice({ orchestrationId }: { orchestrationId: string }) {
	const running = useQuery(
		apiQuery(runListApi.list, {
			query: { status: "running", orchestration_id: orchestrationId, limit: 5 },
		}),
	);
	const runs = running.data?.runs ?? [];
	const first = runs[0];
	if (!first) return null;
	return (
		<output className="mb-3 flex items-center gap-2 rounded-lg border border-signal-line bg-signal-soft px-2.5 py-2 text-sm text-signal-fg">
			<StatusPill kind="running">
				<span className="sr-only">运行中</span>
			</StatusPill>
			<span>
				该场景已有 {runs.length} 个运行中的运行{" "}
				<span className="font-mono">{shortId(first.id)}</span>
			</span>
			<Link
				to="/runs/$id"
				params={{ id: first.id }}
				className="ml-auto underline underline-offset-2"
			>
				查看
			</Link>
		</output>
	);
}

/** 只在下划线后断行，不在单词中间断开；用 <wbr>，它不进读屏名称与复制的文字。 */
const breakableName = (name: string) =>
	name.split("_").map((part, i, parts) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: 参数名按下划线切成的片段，位置就是身份
		<span key={i}>
			{part}
			{i < parts.length - 1 && (
				<>
					_<wbr />
				</>
			)}
		</span>
	));

function ParamField({
	param,
	value,
	error,
	onChange,
	onBlur,
}: {
	param: ParamDeclView;
	value: FieldValue | undefined;
	error: string | undefined;
	onChange: (value: FieldValue) => void;
	onBlur: () => void;
}) {
	const id = useId();
	const labelId = `${id}-label`;
	const helpId = `${id}-help`;
	const errorId = `${id}-error`;
	const [revealed, setRevealed] = useState(false);
	useEffect(() => {
		if (!revealed) return;
		const timer = setTimeout(() => setRevealed(false), REVEAL_MS);
		return () => clearTimeout(timer);
	}, [revealed]);

	const help = param.secret
		? "界面和日志中都会打码"
		: param.default !== undefined && param.type !== "boolean"
			? `默认 ${JSON.stringify(param.default)}`
			: null;
	const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ");
	const aria = {
		id,
		"aria-invalid": error ? true : undefined,
		"aria-describedby": describedBy || undefined,
		"aria-required": param.required || undefined,
	};
	const hidden = param.secret && !revealed;
	let control: React.ReactNode;
	if (param.type === "boolean") {
		control = (
			<div className="flex h-7.5 items-center gap-2">
				<Switch
					{...aria}
					aria-labelledby={labelId}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked)}
					onBlur={onBlur}
				/>
				<span className="font-mono text-xs text-fg-2">{value === true ? "true" : "false"}</span>
			</div>
		);
	} else if (param.type === "json") {
		control = (
			<Textarea
				{...aria}
				rows={3}
				spellCheck={false}
				className="font-mono text-xs"
				value={String(value ?? "")}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
			/>
		);
	} else {
		control = (
			<div className="flex gap-1.5">
				<Input
					{...aria}
					type={hidden ? "password" : "text"}
					inputMode={param.type === "number" ? "decimal" : undefined}
					autoComplete="off"
					spellCheck={false}
					className={param.type === "number" || param.secret ? "font-mono" : undefined}
					value={String(value ?? "")}
					onChange={(e) => onChange(e.target.value)}
					onBlur={onBlur}
				/>
				{param.secret && (
					<Button
						variant="ghost"
						size="icon"
						aria-label={revealed ? `隐藏 ${param.name}` : `临时显示 ${param.name} 5 秒`}
						title={revealed ? "隐藏" : "临时显示 5 秒"}
						onClick={() => setRevealed((r) => !r)}
					>
						{revealed ? <EyeOffIcon /> : <EyeIcon />}
					</Button>
				)}
			</div>
		);
	}
	return (
		<div className="col-span-full grid grid-cols-subgrid items-start">
			<label id={labelId} htmlFor={id} className="min-w-0 pt-1.5 text-sm wrap-anywhere text-fg-2">
				<span className="font-mono">{breakableName(param.name)}</span>
				{param.required && (
					<span aria-hidden className="ml-0.5 text-fg-2">
						*
					</span>
				)}
				<span className="block font-mono text-xs text-fg-3">
					{param.type}
					{param.secret && " · 敏感"}
				</span>
			</label>
			<div className="flex min-w-0 flex-col gap-1.25">
				{control}
				{error && (
					<p id={errorId} className="m-0 text-xs text-danger-fg">
						{error}
					</p>
				)}
				{help && (
					<p id={helpId} className="m-0 text-xs text-fg-3">
						{help}
					</p>
				)}
			</div>
		</div>
	);
}

const CHECK_ICON: Record<
	CheckRow["state"],
	{ icon: React.ReactNode; className: string; label: string }
> = {
	ok: { icon: <CheckIcon />, className: "bg-ok-soft text-ok", label: "通过" },
	warn: { icon: <AlertTriangleIcon />, className: "bg-warn-soft text-warn-fg", label: "提醒" },
	blocked: { icon: <XIcon />, className: "bg-danger-soft text-danger-fg", label: "不通过" },
};

function CheckItem({ row, onLocate }: { row: CheckRow; onLocate?: (nodeId: string) => void }) {
	const icon = CHECK_ICON[row.state];
	return (
		<li
			data-state={row.state}
			className="flex items-start gap-2.5 border-b border-border-soft px-3 py-2 text-sm last:border-b-0"
		>
			<span
				className={cn(
					"mt-0.5 grid size-4 flex-none place-items-center rounded-full [&_svg]:size-2.75",
					icon.className,
				)}
			>
				{icon.icon}
				<span className="sr-only">{icon.label}：</span>
			</span>
			<div className="min-w-0 flex-1">
				<div>{row.title}</div>
				{row.detail && <div className="text-xs text-fg-3">{row.detail}</div>}
				{row.problems.length > 0 && <ProblemList problems={row.problems} onLocate={onLocate} />}
			</div>
		</li>
	);
}

function ProblemList({
	problems,
	onLocate,
}: {
	problems: PreflightProblem[];
	onLocate?: (nodeId: string) => void;
}) {
	return (
		<ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-xs text-fg-2">
			{problems.map((p) => (
				<li key={`${p.code}:${p.node_id ?? ""}:${p.message}`} className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1">{p.message}</span>
					{p.node_id && onLocate && (
						<Button
							variant="link"
							size="sm"
							className="flex-none text-xs"
							onClick={() => onLocate(p.node_id as string)}
						>
							前往 <span className="font-mono">{p.node_id}</span>
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}

function TriggerError({ error, onLocate }: { error: Error; onLocate?: (nodeId: string) => void }) {
	const problems =
		error instanceof ApiError &&
		error.code === "invalid_orchestration" &&
		Array.isArray(error.details)
			? (error.details as PreflightProblem[])
			: null;
	return (
		<div
			role="alert"
			className="mb-3.5 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-fg"
		>
			触发失败：{problems ? "预检没有通过（场景刚刚被修改过）" : error.message}
			{problems && <ProblemList problems={problems} onLocate={onLocate} />}
		</div>
	);
}
