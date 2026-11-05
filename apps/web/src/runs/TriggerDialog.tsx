import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ApiError } from "#/lib/api";
import { Modal } from "#/versions/Modal";
import { getPreflight, type ParamDecl, type PreflightProblem, triggerRun } from "./api";

/** 表单里的值：布尔参数用开关，其余都是输入框里的文本。 */
type FieldValue = string | boolean;

/** 表单初始值：给了 initial（再次运行时沿用上次的参数，敏感参数除外）时用它，否则用默认值。 */
const initialValue = (p: ParamDecl, initial?: Record<string, unknown>): FieldValue => {
	const value = initial && !p.secret && p.name in initial ? initial[p.name] : p.default;
	if (p.type === "boolean") return value === true;
	if (value === undefined || value === null) return "";
	return p.type === "json" ? JSON.stringify(value) : String(value);
};

/** 表单值 → 触发参数；留空的参数不传（按默认值填充，必填参数由控制面报错）。 */
function toParams(
	decls: ParamDecl[],
	values: Record<string, FieldValue>,
	initial?: Record<string, unknown>,
): { params: Record<string, unknown> } | { errors: Record<string, string> } {
	const params: Record<string, unknown> = {};
	const errors: Record<string, string> = {};
	for (const p of decls) {
		const value = values[p.name] ?? initialValue(p, initial);
		if (typeof value === "boolean") {
			params[p.name] = value;
			continue;
		}
		if (value === "") {
			if (p.required && p.default === undefined) errors[p.name] = "必填";
			continue;
		}
		if (p.type === "number") {
			const n = Number(value);
			if (!Number.isFinite(n)) errors[p.name] = "需要一个数字";
			else params[p.name] = n;
		} else if (p.type === "json") {
			try {
				params[p.name] = JSON.parse(value);
			} catch {
				errors[p.name] = "不是合法的 JSON";
			}
		} else {
			params[p.name] = value;
		}
	}
	return Object.keys(errors).length > 0 ? { errors } : { params };
}

/**
 * 触发运行（docs/SEMANTICS.md §6）：先预检——有未保存的修改、画布不是最新版本、结构 / 引用 / 包版本校验失败、
 * 引用的 Agent 未注册时不能触发，并列出原因；通过后按入口参数生成表单，触发后进入运行视图。
 */
export function TriggerDialog({
	orchestrationId,
	dirty = false,
	baseVersion,
	onLocate,
	onClose,
	initialParams,
	title = "触发运行",
}: {
	orchestrationId: string;
	/** 画布上有未保存的修改（本地草稿）。 */
	dirty?: boolean;
	/** 画布显示的版本（编辑起点）；不是从画布打开时不给，不检查版本是否最新。 */
	baseVersion?: number;
	/** 在画布上定位到问题所在的节点。 */
	onLocate?: (nodeId: string) => void;
	onClose: () => void;
	/** 表单初始值（再次运行时为上次运行的参数；敏感参数不沿用，需要重新填写）。 */
	initialParams?: Record<string, unknown>;
	title?: string;
}) {
	const navigate = useNavigate();
	const preflight = useQuery({
		queryKey: ["orchestration", orchestrationId, "preflight"],
		queryFn: () => getPreflight(orchestrationId),
		staleTime: 0,
		gcTime: 0,
	});
	const [values, setValues] = useState<Record<string, FieldValue>>({});
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
	const trigger = useMutation({
		mutationFn: (params: Record<string, unknown>) => triggerRun(orchestrationId, params),
		onSuccess: (run) => navigate({ to: "/runs/$id", params: { id: run.id } }),
	});

	const data = preflight.data;
	const problems: PreflightProblem[] = [];
	if (dirty) {
		problems.push({
			code: "unsaved_draft",
			message: "画布上有未保存的修改。触发只会运行已保存的最新版本，请先保存。",
		});
	}
	if (data && baseVersion !== undefined && data.version > 0 && data.version !== baseVersion) {
		problems.push({
			code: "stale_version",
			message: `最新版本是 ${data.version}，画布显示的是版本 ${baseVersion}（别人保存了新版本）。刷新页面看过最新版本后再触发。`,
		});
	}
	problems.push(...(data?.problems ?? []));
	const blocked = !data || problems.length > 0;

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!data || blocked) return;
		const result = toParams(data.params, values, initialParams);
		if ("errors" in result) {
			setFieldErrors(result.errors);
			return;
		}
		setFieldErrors({});
		trigger.mutate(result.params);
	};

	const formId = useId();
	return (
		<Modal
			title={title}
			description={
				data && data.version > 0
					? `运行绑定到最新版本 ${data.version}。`
					: "运行绑定到场景的最新版本。"
			}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="sf-btn sf-btn--ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form={formId}
						className="sf-btn sf-btn--primary"
						disabled={blocked || trigger.isPending}
					>
						{trigger.isPending ? "触发中…" : "触发"}
					</button>
				</>
			}
		>
			{preflight.isPending && <p className="sf-hint">正在预检…</p>}
			{preflight.error && <p className="sf-err">预检失败：{preflight.error.message}</p>}
			{problems.length > 0 && (
				<section className="sf-sec" aria-label="不能触发的原因">
					<h3>
						不能触发
						<span className="sf-r">{problems.length} 个原因</span>
					</h3>
					<ProblemList
						problems={problems}
						onLocate={
							onLocate &&
							((id) => {
								onLocate(id);
								onClose();
							})
						}
					/>
				</section>
			)}
			{data && problems.length === 0 && (
				<form id={formId} onSubmit={submit} className="sf-sec">
					<h3>
						入口参数
						<span className="sf-r">{data.params.length} 个</span>
					</h3>
					{data.params.length === 0 && <p className="sf-hint">入口节点没有声明参数。</p>}
					{data.params.map((p) => (
						<ParamField
							key={p.name}
							param={p}
							value={values[p.name] ?? initialValue(p, initialParams)}
							error={fieldErrors[p.name]}
							onChange={(v) => setValues((s) => ({ ...s, [p.name]: v }))}
						/>
					))}
					{trigger.error && <TriggerError error={trigger.error} />}
				</form>
			)}
		</Modal>
	);
}

export function ProblemList({
	problems,
	onLocate,
}: {
	problems: PreflightProblem[];
	onLocate?: (nodeId: string) => void;
}) {
	return (
		<ul className="space-y-1">
			{problems.map((p) => (
				<li key={`${p.code}:${p.node_id ?? ""}:${p.message}`} className="sf-warn-item">
					<span>{p.message}</span>
					{p.node_id && onLocate && (
						<button
							type="button"
							className="sf-link ml-2 text-xs"
							onClick={() => onLocate(p.node_id as string)}
						>
							前往 {p.node_id}
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

function ParamField({
	param,
	value,
	error,
	onChange,
}: {
	param: ParamDecl;
	value: FieldValue;
	error: string | undefined;
	onChange: (value: FieldValue) => void;
}) {
	const id = useId();
	const label = (
		<label htmlFor={id}>
			<code>{param.name}</code>
			{param.required && <span className="sf-required"> *</span>}
		</label>
	);
	const hint = [
		param.type,
		param.required ? "必填" : "可选",
		param.secret ? "敏感，界面中打码" : null,
	]
		.filter(Boolean)
		.join(" · ");
	if (typeof value === "boolean") {
		return (
			<div className="sf-field">
				{label}
				<div>
					<button
						id={id}
						type="button"
						role="switch"
						aria-checked={value}
						className="sf-tg"
						onClick={() => onChange(!value)}
					>
						<span className="sf-tx">
							<b>{value ? "true" : "false"}</b>
							<span>{hint}</span>
						</span>
						<span className="sf-sw" aria-hidden="true" />
					</button>
				</div>
			</div>
		);
	}
	const common = {
		id,
		value,
		"aria-invalid": error ? true : undefined,
		className: `sf-inp ${param.type === "string" ? "" : "sf-inp--mono"} ${error ? "sf-inp--bad" : ""}`,
		placeholder: param.default === undefined ? "" : `默认 ${JSON.stringify(param.default)}`,
	};
	return (
		<div className="sf-field">
			{label}
			<div>
				{param.type === "json" ? (
					<textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
				) : (
					<input
						{...common}
						type={param.secret ? "password" : "text"}
						inputMode={param.type === "number" ? "decimal" : undefined}
						autoComplete="off"
						onChange={(e) => onChange(e.target.value)}
					/>
				)}
				<p className={error ? "sf-err" : "sf-hint"}>{error ?? hint}</p>
			</div>
		</div>
	);
}

function TriggerError({ error }: { error: Error }) {
	const problems =
		error instanceof ApiError &&
		error.code === "invalid_orchestration" &&
		Array.isArray(error.details)
			? (error.details as PreflightProblem[])
			: null;
	return (
		<div className="mt-3">
			<p className="sf-err">触发失败：{problems ? "预检没有通过" : error.message}</p>
			{problems && <ProblemList problems={problems} />}
		</div>
	);
}
