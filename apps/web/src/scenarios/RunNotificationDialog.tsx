import {
	feishuBotsApi,
	type OrchestrationView,
	orchestrationsApi,
	RUN_NOTIFICATION_NOTE_MAX,
	RUN_NOTIFICATION_TITLE_MAX,
	type RunNotificationSettings,
	type RunNotificationTrigger,
} from "@sfly/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { FeishuBotSelect } from "#/editor/inspector/FeishuBotSelect";
import { apiQuery, callApi } from "#/lib/api";
import { PAGE, TERM } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useInvalidateScenarios } from "./dialogs";

/** 触发条件的文字（GLOSSARY「运行通知」）。 */
const TRIGGERS: ReadonlyArray<{ value: RunNotificationTrigger; label: string }> = [
	{ value: "failed", label: "仅失败" },
	{ value: "failed_or_cancelled", label: "失败和取消" },
	{ value: "always", label: "总是（成功、失败、取消都发）" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 一项设置：标签、控件和下面的提示。 */
function Row({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={htmlFor} className="text-xs text-fg-2">
				{label}
			</label>
			{children}
			{hint && <p className="m-0 text-xs text-fg-3">{hint}</p>}
		</div>
	);
}

/**
 * 运行通知：场景运行结束时，由控制面往选中的飞书机器人发一张卡片。这些设置和名称、说明一样不属于场景版本，
 * 修改后立即生效、不产生新版本。机器人为空即关闭；选中的机器人已被删除时给出提示，运行不受影响。
 */
export function RunNotificationDialog({
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
	const bots = useQuery({ ...apiQuery(feishuBotsApi.list), enabled: open });
	const [settings, setSettings] = useState<RunNotificationSettings>(scenario.run_notification);
	useEffect(() => {
		if (open) setSettings(scenario.run_notification);
	}, [open, scenario.run_notification]);
	const save = useMutation({
		mutationFn: (value: RunNotificationSettings) =>
			callApi(orchestrationsApi.update, {
				params: { id: scenario.id },
				body: { run_notification: value },
			}),
		onSuccess: async () => {
			onOpenChange(false);
			notify.success("已保存运行通知");
			await invalidate();
		},
		onError: (error) => notify.error("保存失败", { description: errorText(error) }),
	});
	const botId = useId();
	const triggerId = useId();
	const titleId = useId();
	const noteId = useId();
	const registered = bots.data?.bots ?? [];
	const missing =
		settings.bot !== null &&
		bots.data !== undefined &&
		!registered.some((b) => b.name === settings.bot);
	const set = (changes: Partial<RunNotificationSettings>) =>
		setSettings((current) => ({ ...current, ...changes }));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent finalFocus={returnFocus}>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						save.mutate(settings);
					}}
				>
					<DialogHeader>
						<DialogTitle>{TERM.runNotification}</DialogTitle>
						<DialogDescription>
							运行结束时往选中的{TERM.feishuBot}
							发一张卡片，不用在链上加节点。这些设置不属于场景版本，
							修改后不会生成新版本，立即生效；复制场景时一并复制。
						</DialogDescription>
					</DialogHeader>
					<Row label={TERM.feishuBot} htmlFor={botId}>
						<FeishuBotSelect
							id={botId}
							label={TERM.feishuBot}
							value={settings.bot ?? undefined}
							bots={registered}
							emptyLabel="（不发送运行通知）"
							invalid={missing}
							onChange={(bot) => set({ bot: bot ?? null })}
						/>
					</Row>
					{missing && (
						<p role="alert" className="m-0 text-xs text-danger-fg">
							{TERM.feishuBot}「{settings.bot}
							」已被删除，运行结束时不会发送通知，运行详情里记为「未发送」。
							可以换一个机器人，或者到
							<Link to="/feishu-bots" className="underline underline-offset-2">
								{PAGE.feishuBots}
							</Link>
							重新登记同名的机器人。
						</p>
					)}
					<Row label="触发条件" htmlFor={triggerId}>
						<NativeSelect
							id={triggerId}
							value={settings.trigger}
							onChange={(e) => set({ trigger: e.target.value as RunNotificationTrigger })}
						>
							{TRIGGERS.map((t) => (
								<NativeSelectOption key={t.value} value={t.value}>
									{t.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Row>
					<Row
						label="卡片标题"
						htmlFor={titleId}
						hint="留空时用场景名。群里有多个场景或环境时，可以写成「【订单压测-A 环境】」。"
					>
						<Input
							id={titleId}
							value={settings.title}
							onChange={(e) => set({ title: e.target.value })}
							maxLength={RUN_NOTIFICATION_TITLE_MAX}
							placeholder={scenario.name}
						/>
					</Row>
					<Row label="附加说明" htmlFor={noteId} hint="Markdown，放在卡片正文的最前面，可以 @ 人。">
						<Textarea
							id={noteId}
							value={settings.note}
							onChange={(e) => set({ note: e.target.value })}
							maxLength={RUN_NOTIFICATION_NOTE_MAX}
							rows={3}
						/>
					</Row>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={save.isPending}>
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
