import {
	orchestrationsApi,
	type ParamDeclView,
	PRESET_DESCRIPTION_MAX,
	type PresetView,
	presetsApi,
} from "@sfly/schema";
import { type UseQueryResult, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { ErrorState } from "#/components/feedback/states";
import { apiQuery, callApi } from "#/lib/api";
import { TERM } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import { ParamField } from "#/run-drawer/ParamField";
import { Badge } from "@/components/ui/badge";
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
import { CopyPresetForm } from "./CopyPresetForm";
import { DeletePresetConfirm } from "./DeletePresetConfirm";
import { GoneParams } from "./GoneParams";
import {
	hasRepairErrors,
	keepGone,
	noRepair,
	problemsText,
	type Repair,
	refilled,
	repairDraft,
	repairErrors,
	repairOf,
} from "./invalid-preset";
import { useInvalidatePresets } from "./invalidate";
import {
	draftErrors,
	emptyDraft,
	hasErrors,
	type PresetDraft,
	replaceSecret,
	toggleParam,
	toPresetBody,
} from "./preset-form";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 预设参数的值在列表里怎么写：字符串原样，其余按 JSON。 */
const valueText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** 管理对话框里的一屏：列表，新建或编辑的表单（给了 `preset` 就是编辑），复制，删除确认。 */
type View =
	| { kind: "list" }
	| { kind: "form"; preset?: PresetView }
	| { kind: "copy"; preset: PresetView }
	| { kind: "delete"; preset: PresetView };

/**
 * 运行预设（GLOSSARY「运行预设」，ADR 0023）：列出场景的预设，新建、编辑、复制、删除。预设是场景的设置，
 * 不属于场景版本，修改后立即生效，场景归档期间也能修改；参数按名称对照最新版本的入口参数。
 * 列表、编辑表单、复制和删除确认是同一个弹窗里的几屏。
 */
export function RunPresetsDialog({
	scenario,
	open,
	onOpenChange,
	returnFocus,
}: {
	scenario: { id: string; name: string; archived_at?: string | null };
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const [view, setView] = useState<View>({ kind: "list" });
	/** 回到列表时焦点放回哪个按钮：`create`，或 `edit:<预设 id>`、`copy:<预设 id>`、`delete:<预设 id>`。 */
	const [focusKey, setFocusKey] = useState<string | null>(null);
	useEffect(() => {
		if (open) {
			setView({ kind: "list" });
			setFocusKey(null);
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
	const toList = (focus: string) => {
		setView({ kind: "list" });
		setFocusKey(focus);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent finalFocus={returnFocus} className="w-150">
				{view.kind === "form" ? (
					<PresetForm
						key={view.preset?.id ?? "new"}
						orchestrationId={scenario.id}
						decls={decls}
						preset={view.preset}
						onCancel={() => toList(view.preset ? `edit:${view.preset.id}` : "create")}
						onSaved={() => toList(view.preset ? `edit:${view.preset.id}` : "create")}
					/>
				) : view.kind === "copy" ? (
					<CopyPresetForm
						orchestrationId={scenario.id}
						preset={view.preset}
						onCancel={() => toList(`copy:${view.preset.id}`)}
						onCopied={() => toList(`copy:${view.preset.id}`)}
					/>
				) : view.kind === "delete" ? (
					<DeletePresetConfirm
						orchestrationId={scenario.id}
						preset={view.preset}
						onCancel={() => toList(`delete:${view.preset.id}`)}
						onDeleted={() => toList("create")}
					/>
				) : (
					<PresetList
						scenarioName={scenario.name}
						archived={scenario.archived_at != null}
						presets={presets}
						decls={decls}
						canCreate={head.data !== undefined && decls.length > 0}
						noParams={head.data !== undefined && decls.length === 0}
						focusKey={focusKey}
						onCreate={() => setView({ kind: "form" })}
						onEdit={(preset) => setView({ kind: "form", preset })}
						onCopy={(preset) => setView({ kind: "copy", preset })}
						onDelete={(preset) => setView({ kind: "delete", preset })}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function PresetList({
	scenarioName,
	archived,
	presets,
	decls,
	canCreate,
	noParams,
	focusKey,
	onCreate,
	onEdit,
	onCopy,
	onDelete,
}: {
	scenarioName: string;
	archived: boolean;
	presets: UseQueryResult<{ presets: PresetView[] }>;
	decls: ParamDeclView[];
	canCreate: boolean;
	noParams: boolean;
	/** 从别的屏回到列表时要放回焦点的按钮（见 RunPresetsDialog）；没有时不动。 */
	focusKey: string | null;
	onCreate: () => void;
	onEdit: (preset: PresetView) => void;
	onCopy: (preset: PresetView) => void;
	onDelete: (preset: PresetView) => void;
}) {
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	const keyed = (key: string) => (el: HTMLButtonElement | null) => {
		if (el) buttons.current.set(key, el);
		else buttons.current.delete(key);
	};
	useEffect(() => {
		if (focusKey === null) return;
		// 删掉的预设没有按钮了：焦点落到「新建预设」。
		(buttons.current.get(focusKey) ?? buttons.current.get("create"))?.focus();
	}, [focusKey]);
	const list = presets.data?.presets;
	return (
		<>
			<DialogHeader>
				<DialogTitle>{TERM.runPreset}</DialogTitle>
				<DialogDescription>
					「{scenarioName}」保存的几套入口参数。触发运行时选用一套，预设参数取它保存的值、不能修改，
					其余参数照常填写。预设不属于场景版本，修改后不会生成新版本，立即生效。
					{archived && "场景已归档：运行预设原样保留，也能修改；恢复场景后照常使用。"}
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
								className="flex items-start gap-3 rounded-lg border border-border-soft px-3 py-2 text-sm"
							>
								<div className="min-w-0 flex-1">
									<div className="font-medium wrap-anywhere text-fg-1">
										{preset.name}
										{preset.status === "invalid" && (
											<Badge variant="danger" className="ml-2 align-middle">
												已失效
											</Badge>
										)}
									</div>
									{preset.description && (
										<div className="text-xs wrap-anywhere text-fg-3">{preset.description}</div>
									)}
									<div className="mt-1 font-mono text-xs wrap-anywhere text-fg-2">
										{preset.params.map((p) => `${p.name} = ${valueText(p.value)}`).join(" · ")}
									</div>
									{preset.status === "invalid" && (
										<div className="mt-1 text-xs wrap-anywhere text-danger-fg">
											{problemsText(preset.problems, decls)}
											。失效的预设不能用来触发运行，编辑并改好之后恢复可用。
										</div>
									)}
									<div className="mt-1 text-xs text-fg-3">
										最后修改 {preset.updated_by} ·{" "}
										<span className="font-mono">{formatDateTime(preset.updated_at)}</span>
									</div>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										size="sm"
										variant="ghost"
										ref={keyed(`edit:${preset.id}`)}
										aria-label={`编辑 ${preset.name}`}
										disabled={!canCreate}
										onClick={() => onEdit(preset)}
									>
										编辑
									</Button>
									<Button
										size="sm"
										variant="ghost"
										ref={keyed(`copy:${preset.id}`)}
										aria-label={`复制 ${preset.name}`}
										onClick={() => onCopy(preset)}
									>
										复制
									</Button>
									<Button
										size="sm"
										variant="ghost"
										ref={keyed(`delete:${preset.id}`)}
										aria-label={`删除 ${preset.name}`}
										onClick={() => onDelete(preset)}
									>
										删除
									</Button>
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
				<Button ref={keyed("create")} variant="primary" disabled={!canCreate} onClick={onCreate}>
					新建预设
				</Button>
			</DialogFooter>
		</>
	);
}

/**
 * 新建或编辑预设的表单：名称、说明，最新版本的每个入口参数一行，勾选「预设」的参数要填上固定的值。
 * 给了 `preset` 是编辑：带着它现在的内容，保存时预设参数的完整清单就是勾选的参数。
 */
function PresetForm({
	orchestrationId,
	decls,
	preset,
	onCancel,
	onSaved,
}: {
	orchestrationId: string;
	decls: ParamDeclView[];
	preset?: PresetView | undefined;
	onCancel: () => void;
	onSaved: () => void;
}) {
	const invalidate = useInvalidatePresets();
	const form = useRef<HTMLFormElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<PresetDraft>(() =>
		preset ? repairDraft(preset, decls) : emptyDraft(),
	);
	// 编辑失效的预设时还没修好的地方：已不存在的参数要取消勾选，类型不对的值要重新填写。
	const [repair, setRepair] = useState<Repair>(() => (preset ? repairOf(preset, decls) : noRepair));
	const [submitted, setSubmitted] = useState(false);
	useEffect(() => {
		nameInput.current?.focus();
	}, []);
	const save = useMutation({
		mutationFn: (value: PresetDraft) => {
			const body = toPresetBody(value, decls);
			return preset
				? callApi(presetsApi.update, { params: { id: orchestrationId, presetId: preset.id }, body })
				: callApi(presetsApi.create, { params: { id: orchestrationId }, body });
		},
		onSuccess: async (saved) => {
			notify.success(
				preset ? `已保存运行预设「${saved.name}」` : `已新建运行预设「${saved.name}」`,
			);
			await invalidate();
			onSaved();
		},
	});
	// 第一次提交之前不显示错误；之后随输入更新。
	const errors = submitted ? draftErrors(draft, decls) : { values: {} };
	// 要修的地方一打开就标出来，不等提交。
	const unrepaired = repairErrors(repair, draft);

	return (
		<form
			ref={form}
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				setSubmitted(true);
				if (hasErrors(draftErrors(draft, decls)) || hasRepairErrors(unrepaired)) {
					requestAnimationFrame(() =>
						form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
					);
					return;
				}
				save.mutate(draft);
			}}
		>
			<DialogHeader>
				<DialogTitle>
					{preset ? "编辑" : "新建"}
					{TERM.runPreset}
				</DialogTitle>
				<DialogDescription>
					勾选「预设」的参数由预设固定，触发时不能修改；没勾选的参数触发时照常填写。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				{preset?.status === "invalid" && (
					<p role="note" className="m-0 text-xs text-danger-fg">
						这个运行预设已失效，不能用来触发运行：{problemsText(preset.problems, decls)}。
						改好下面标出的地方，保存之后恢复可用。
					</p>
				)}
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
				<GoneParams
					repair={repair}
					error={submitted ? unrepaired.gone : undefined}
					onKeep={(name, keep) => setRepair(keepGone(repair, name, keep))}
				/>
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
								error={unrepaired.values[p.name] ?? errors.values[p.name]}
								disabled={!checked}
								kept={draft.keptSecrets.includes(p.name)}
								onReplace={() => setDraft(replaceSecret(draft, p.name))}
								onChange={(value) => {
									setDraft({ ...draft, values: { ...draft.values, [p.name]: value } });
									setRepair(refilled(repair, p.name));
								}}
								leading={
									<span className="pt-2">
										<Checkbox
											aria-label={`预设 ${p.name}`}
											checked={checked}
											onChange={(e) => {
												setDraft(toggleParam(draft, p, e.target.checked));
												setRepair(refilled(repair, p.name));
											}}
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
