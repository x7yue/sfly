import { domainKey, type OrchestrationView, orchestrationsApi } from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
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
import { Textarea } from "@/components/ui/textarea";

/**
 * 场景的弹窗：新建、复制、编辑名称和说明、归档确认。成功后让场景领域（orchestrations）的查询全部重新获取。
 */

/** 场景相关查询全部失效。 */
export function useInvalidateScenarios() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: domainKey(orchestrationsApi.list) });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 名称（必填）+ 可选说明的表单弹窗。 */
function NameDescriptionDialog({
	open,
	onOpenChange,
	title,
	description,
	initialName,
	initialDescription,
	withDescription = true,
	submitLabel,
	pending,
	error,
	onOpen,
	onSubmit,
	returnFocus,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	initialName: string;
	initialDescription?: string;
	withDescription?: boolean;
	submitLabel: string;
	pending: boolean;
	error: unknown;
	onOpen: () => void;
	onSubmit: (values: { name: string; description: string }) => void;
	/** 关闭后焦点回到的元素（从菜单里打开时，菜单项已经不在了）。 */
	returnFocus?: React.RefObject<HTMLElement | null> | undefined;
}) {
	const [name, setName] = useState(initialName);
	const [text, setText] = useState(initialDescription ?? "");
	const [submitted, setSubmitted] = useState(false);
	const nameInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (open) {
			setName(initialName);
			setText(initialDescription ?? "");
			setSubmitted(false);
			onOpen();
		}
	}, [open, initialName, initialDescription, onOpen]);
	const nameError = name.trim() ? undefined : "填写场景名称";
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent finalFocus={returnFocus}>
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						setSubmitted(true);
						if (nameError) nameInput.current?.focus();
						else onSubmit({ name: name.trim(), description: text.trim() });
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<FormField label="名称" required error={submitted ? nameError : undefined}>
							{(control) => (
								<Input
									{...control}
									ref={nameInput}
									value={name}
									onChange={(e) => setName(e.target.value)}
									maxLength={120}
									autoFocus
								/>
							)}
						</FormField>
						{withDescription && (
							<FormField label="说明">
								{(control) => (
									<Textarea
										{...control}
										value={text}
										onChange={(e) => setText(e.target.value)}
										placeholder="这个场景测什么、在哪个环境跑（可选）"
										rows={3}
									/>
								)}
							</FormField>
						)}
						{error !== null && error !== undefined && <FormAlert>{errorText(error)}</FormAlert>}
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={pending}>
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** 新建场景（全局浮层，命令面板和场景页都能打开）：自带入口节点，建好后进入编排画布。 */
export function NewScenarioDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const invalidate = useInvalidateScenarios();
	const create = useMutation({
		mutationFn: (body: { name: string; description: string }) =>
			callApi(orchestrationsApi.create, { body }),
		onSuccess: async (created) => {
			onOpenChange(false);
			notify.success(`已新建场景「${created.name}」`);
			await invalidate();
			navigate({ to: "/orchestrations/$id", params: { id: created.id } });
		},
	});
	return (
		<NameDescriptionDialog
			open={open}
			onOpenChange={onOpenChange}
			title="新建场景"
			description="新场景自带一个入口节点，建好后进入编排画布搭建链路。"
			initialName=""
			submitLabel="新建"
			pending={create.isPending}
			error={create.error}
			onOpen={create.reset}
			onSubmit={(values) => create.mutate(values)}
		/>
	);
}

/** 复制场景：输入新名称；说明和最新版本的链路一起复制。 */
export function CopyScenarioDialog({
	scenario,
	open,
	onOpenChange,
	returnFocus,
}: {
	scenario: OrchestrationView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const invalidate = useInvalidateScenarios();
	const copy = useMutation({
		mutationFn: (name: string) =>
			callApi(orchestrationsApi.copy, { params: { id: scenario.id }, body: { name } }),
		onSuccess: async (copied) => {
			onOpenChange(false);
			notify.success(`已复制为「${copied.name}」`);
			await invalidate();
		},
	});
	return (
		<NameDescriptionDialog
			open={open}
			onOpenChange={onOpenChange}
			title="复制场景"
			description={`复制「${scenario.name}」的说明和最新版本的链路，用新名称保存为另一个场景（例如换一个测试环境）。`}
			initialName={`${scenario.name} 副本`}
			withDescription={false}
			submitLabel="复制"
			pending={copy.isPending}
			error={copy.error}
			onOpen={copy.reset}
			returnFocus={returnFocus}
			onSubmit={({ name }) => copy.mutate(name)}
		/>
	);
}

/** 编辑名称和说明：不产生新的场景版本。 */
export function EditScenarioDialog({
	scenario,
	open,
	onOpenChange,
	returnFocus,
}: {
	scenario: OrchestrationView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const invalidate = useInvalidateScenarios();
	const update = useMutation({
		mutationFn: (body: { name: string; description: string }) =>
			callApi(orchestrationsApi.update, { params: { id: scenario.id }, body }),
		onSuccess: async () => {
			onOpenChange(false);
			notify.success("已保存名称和说明");
			await invalidate();
		},
	});
	return (
		<NameDescriptionDialog
			open={open}
			onOpenChange={onOpenChange}
			title="编辑名称和说明"
			description="名称和说明不属于场景版本，修改后不会生成新版本。"
			initialName={scenario.name}
			initialDescription={scenario.description}
			submitLabel="保存"
			pending={update.isPending}
			error={update.error}
			onOpen={update.reset}
			returnFocus={returnFocus}
			onSubmit={(values) => update.mutate(values)}
		/>
	);
}

export function ArchiveScenarioDialog({
	scenario,
	open,
	onOpenChange,
	returnFocus,
}: {
	scenario: OrchestrationView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus?: React.RefObject<HTMLElement | null>;
}) {
	const invalidate = useInvalidateScenarios();
	const unarchive = useUnarchiveScenario();
	const archive = useMutation({
		mutationFn: () => callApi(orchestrationsApi.archive, { params: { id: scenario.id } }),
		onSuccess: async () => {
			onOpenChange(false);
			notify.success(`已归档「${scenario.name}」`, {
				action: { label: "撤销", onClick: () => unarchive.mutate(scenario) },
			});
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) archive.reset();
	}, [open, archive.reset]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent finalFocus={returnFocus}>
				<DialogHeader>
					<DialogTitle>归档「{scenario.name}」？</DialogTitle>
					<DialogDescription>
						归档后场景不再出现在列表里，也不能运行；历史运行仍可回看。可以随时在「已归档」里恢复。
					</DialogDescription>
				</DialogHeader>
				{archive.isError && <FormAlert>不能归档：{errorText(archive.error)}</FormAlert>}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						保留场景
					</Button>
					<Button variant="danger" disabled={archive.isPending} onClick={() => archive.mutate()}>
						归档
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 恢复已归档的场景（直接执行，结果用通知告知）。 */
export function useUnarchiveScenario() {
	const invalidate = useInvalidateScenarios();
	return useMutation({
		mutationFn: (scenario: OrchestrationView) =>
			callApi(orchestrationsApi.unarchive, { params: { id: scenario.id } }),
		onSuccess: async (restored) => {
			notify.success(`已恢复「${restored.name}」`);
			await invalidate();
		},
		onError: (error) => notify.error("恢复失败", { description: errorText(error) }),
	});
}
