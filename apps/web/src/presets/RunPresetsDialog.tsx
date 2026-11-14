import {
	domainKey,
	orchestrationsApi,
	type ParamDeclView,
	PRESET_DESCRIPTION_MAX,
	type PresetView,
	presetsApi,
} from "@sfly/schema";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { ErrorState } from "#/components/feedback/states";
import { apiQuery, callApi } from "#/lib/api";
import { TERM } from "#/lib/copy";
import { ParamField } from "#/run-drawer/ParamField";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
	draftErrors,
	emptyDraft,
	hasErrors,
	type PresetDraft,
	presetable,
	toggleParam,
	toPresetBody,
} from "./preset-form";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 预设参数的值在列表里怎么写：字符串原样，其余按 JSON。 */
const valueText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * 运行预设（GLOSSARY「运行预设」，ADR 0023）：列出场景的预设、新建预设。预设是场景的设置，不属于场景版本，
 * 修改后立即生效；参数按名称对照最新版本的入口参数。列表和编辑表单是同一个弹窗里的两屏。
 */
export function RunPresetsDialog({
	scenario,
	open,
	onOpenChange,
	returnFocus,
}: {
	scenario: { id: string; name: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const [view, setView] = useState<"list" | "create">("list");
	const [returned, setReturned] = useState(false);
	useEffect(() => {
		if (open) {
			setView("list");
			setReturned(false);
		}
	}, [open]);
	const presets = useQuery({
		...apiQuery(presetsApi.list, { params: { id: scenario.id } }),
		enabled: open,
	});
	const head = useQuery({
		...apiQuery(orchestrationsApi.head, { params: { id: scenario.id } }),
		enabled: open,
	});
	const entry = head.data?.document.nodes.find((n) => n.kind === "entry");
	const decls: ParamDeclView[] = entry?.kind === "entry" ? entry.params : [];
	const back = () => {
		setView("list");
		setReturned(true);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent finalFocus={returnFocus} className="w-150">
				{view === "create" ? (
					<PresetForm orchestrationId={scenario.id} decls={decls} onCancel={back} onSaved={back} />
				) : (
					<PresetList
						scenarioName={scenario.name}
						presets={presets}
						canCreate={head.data !== undefined && decls.length > 0}
						noParams={head.data !== undefined && decls.length === 0}
						focusCreate={returned}
						onCreate={() => setView("create")}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function PresetList({
	scenarioName,
	presets,
	canCreate,
	noParams,
	focusCreate,
	onCreate,
}: {
	scenarioName: string;
	presets: UseQueryResult<{ presets: PresetView[] }>;
	canCreate: boolean;
	noParams: boolean;
	/** 从编辑表单回到列表：焦点放回「新建预设」。 */
	focusCreate: boolean;
	onCreate: () => void;
}) {
	const create = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (focusCreate) create.current?.focus();
	}, [focusCreate]);
	const list = presets.data?.presets;
	return (
		<>
			<DialogHeader>
				<DialogTitle>{TERM.runPreset}</DialogTitle>
				<DialogDescription>
					「{scenarioName}」保存的几套入口参数。触发运行时选用一套，预设参数取它保存的值、不能修改，
					其余参数照常填写。预设不属于场景版本，修改后不会生成新版本，立即生效。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				{presets.error && !list ? (
					<ErrorState
						title="无法读取运行预设"
						error={presets.error}
						onRetry={() => void presets.refetch()}
					/>
				) : !list ? (
					<output aria-label="正在加载" className="flex flex-col gap-2">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</output>
				) : list.length === 0 ? (
					<p className="m-0 text-sm text-fg-3">
						还没有运行预设。新建一个，触发时一步选定这套参数。
					</p>
				) : (
					<ul aria-label={TERM.runPreset} className="m-0 flex list-none flex-col gap-2 p-0">
						{list.map((preset) => (
							<li
								key={preset.id}
								className="rounded-lg border border-border-soft px-3 py-2 text-sm"
							>
								<div className="font-medium text-fg-1">{preset.name}</div>
								{preset.description && (
									<div className="text-xs text-fg-3">{preset.description}</div>
								)}
								<div className="mt-1 font-mono text-xs wrap-anywhere text-fg-2">
									{preset.params.map((p) => `${p.name} = ${valueText(p.value)}`).join(" · ")}
								</div>
							</li>
						))}
					</ul>
				)}
				{noParams && (
					<p className="m-0 mt-3 text-xs text-fg-3">
						入口节点没有声明参数，不能新建运行预设。先在编排画布里给入口节点加上参数并保存。
					</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button ref={create} variant="primary" disabled={!canCreate} onClick={onCreate}>
					新建预设
				</Button>
			</DialogFooter>
		</>
	);
}

/** 新建预设的表单：名称、说明，最新版本的每个入口参数一行，勾选「预设」的参数要填上固定的值。 */
function PresetForm({
	orchestrationId,
	decls,
	onCancel,
	onSaved,
}: {
	orchestrationId: string;
	decls: ParamDeclView[];
	onCancel: () => void;
	onSaved: () => void;
}) {
	const queryClient = useQueryClient();
	const form = useRef<HTMLFormElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
	const [submitted, setSubmitted] = useState(false);
	useEffect(() => {
		nameInput.current?.focus();
	}, []);
	const save = useMutation({
		mutationFn: (value: PresetDraft) =>
			callApi(presetsApi.create, {
				params: { id: orchestrationId },
				body: toPresetBody(value, decls),
			}),
		onSuccess: async (preset) => {
			notify.success(`已新建运行预设「${preset.name}」`);
			await queryClient.invalidateQueries({ queryKey: domainKey(presetsApi.list) });
			onSaved();
		},
	});
	// 第一次提交之前不显示错误；之后随输入更新。
	const errors = submitted ? draftErrors(draft, decls) : { values: {} };

	return (
		<form
			ref={form}
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				setSubmitted(true);
				if (hasErrors(draftErrors(draft, decls))) {
					requestAnimationFrame(() =>
						form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
					);
					return;
				}
				save.mutate(draft);
			}}
		>
			<DialogHeader>
				<DialogTitle>新建{TERM.runPreset}</DialogTitle>
				<DialogDescription>
					勾选「预设」的参数由预设固定，触发时不能修改；没勾选的参数触发时照常填写。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<FormField label="名称" required error={errors.name}>
					{(control) => (
						<Input
							{...control}
							ref={nameInput}
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
					)}
				</FormField>
				<FormField label="说明" error={errors.description}>
					{(control) => (
						<Textarea
							{...control}
							rows={2}
							maxLength={PRESET_DESCRIPTION_MAX}
							value={draft.description}
							onChange={(e) => setDraft({ ...draft, description: e.target.value })}
						/>
					)}
				</FormField>
				<div className="grid grid-cols-[auto_fit-content(40%)_minmax(0,1fr)] items-start gap-x-2.5 gap-y-3">
					<div className="col-span-full grid grid-cols-subgrid text-xs text-fg-3">
						<span>预设</span>
						<span>入口参数</span>
						<span>固定的值</span>
					</div>
					{decls.map((p) => {
						const checked = Object.hasOwn(draft.values, p.name);
						return (
							<ParamField
								key={p.name}
								param={p}
								value={draft.values[p.name] ?? (p.type === "boolean" ? false : "")}
								error={errors.values[p.name]}
								disabled={!checked}
								help={presetable(p) ? undefined : "secret 参数暂不支持设为预设参数"}
								onChange={(value) =>
									setDraft({ ...draft, values: { ...draft.values, [p.name]: value } })
								}
								leading={
									<span className="pt-2">
										<Checkbox
											aria-label={`预设 ${p.name}`}
											checked={checked}
											disabled={!presetable(p)}
											onChange={(e) => setDraft(toggleParam(draft, p, e.target.checked))}
										/>
									</span>
								}
							/>
						);
					})}
				</div>
				{errors.params && (
					<p role="alert" className="m-0 text-xs text-danger-fg">
						{errors.params}
					</p>
				)}
				{save.isError && <FormAlert>{errorText(save.error)}</FormAlert>}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onCancel}>
					取消
				</Button>
				<Button type="submit" variant="primary" disabled={save.isPending}>
					保存
				</Button>
			</DialogFooter>
		</form>
	);
}
