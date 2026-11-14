import {
	domainKey,
	orchestrationsApi,
	type PreflightProblem,
	type RunView,
	runListApi,
	runsApi,
} from "@sfly/schema";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { AlertTriangleIcon, CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "#/components/feedback/states";
import { StatusPill } from "#/components/status";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { shortId } from "#/lib/format";
import { useNickname } from "#/lib/nickname";
import { writeRunView } from "#/monitor/live-run";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type CheckRow, type LocalState, type Preflight, preflightChecks } from "./checks";
import { ParamField } from "./ParamField";
import { PresetSelect } from "./PresetSelect";
import { initialValues, lockedValue, paramsSchema, toParams } from "./trigger-form";

export interface TriggerOptions extends LocalState {
	/** 「前往」问题所在的节点（画布上定位，或进入画布并选中）。 */
	onLocate?: (nodeId: string) => void;
	/** 表单初始值（再次运行时为上次运行的参数；敏感参数不沿用，需要重新填写）。 */
	initialParams?: Record<string, unknown>;
}

/**
 * 运行抽屉的表单阶段（原型 drawerHTML 的 form）：已有运行中的提示、运行预设（场景有预设时）、入口参数（按入口节点的声明生成，
 * TanStack Form + zod 校验；选中预设时预设参数只读）、触发前检查清单、触发人。底部的「取消」「触发运行」由 RunDrawer 渲染，
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
	const [presetId, setPresetId] = useState<string | null>(null);
	const preset = preflight.presets.find((p) => p.id === presetId);
	// 选中预设时，预设参数取预设的值、不能修改，只提交其余参数和预设（控制面填入预设的值）。
	const locked = new Map(preset?.params.map((p) => [p.name, p.value]));
	const editable = decls.filter((p) => !locked.has(p.name));
	const trigger = useMutation({
		mutationFn: (body: { params: Record<string, unknown>; preset?: string }) =>
			callApi(runsApi.trigger, { params: { id: orchestrationId }, body }),
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
		validators: { onDynamic: paramsSchema(editable) },
		onSubmit: ({ value }) => {
			if (checks.blocked) return;
			const params = toParams(editable, value);
			trigger.mutate(preset ? { params, preset: preset.id } : { params });
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
			{preflight.presets.length > 0 && (
				<PresetSelect presets={preflight.presets} value={presetId} onChange={setPresetId} />
			)}
			<SectionTitle first>
				入口参数
				<span className="ml-auto font-normal text-fg-3">{decls.length} 个</span>
			</SectionTitle>
			{decls.length === 0 && <p className="m-0 mb-3 text-xs text-fg-3">入口节点没有声明参数。</p>}
			{/* 标签列的宽度在这里定一次，所有参数共用：输入框的左右沿对齐 */}
			<div className="mb-3 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-start gap-x-2.5 gap-y-3">
				{decls.map((p) =>
					preset && locked.has(p.name) ? (
						<ParamField
							key={p.name}
							param={p}
							value={lockedValue(p, locked.get(p.name))}
							lockedBy={preset.name}
						/>
					) : (
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
					),
				)}
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
