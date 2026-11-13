import {
	domainKey,
	FEISHU_BOT_NAME_MAX,
	type FeishuBotReference,
	type FeishuBotView,
	feishuBotsApi,
	isHttpUrl,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { apiQuery, callApi } from "#/lib/api";
import { FEISHU_BOT_SETUP } from "#/lib/copy";
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

/**
 * 飞书机器人的弹窗（ADR 0020）：登记、替换 Webhook 地址、删除确认。成功后让飞书机器人领域的查询全部重新获取。
 * 接口只返回打码的地址，所以替换时只能整个重新填，看不到原值。
 */

/** 飞书机器人相关查询全部失效。 */
function useInvalidateBots() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: domainKey(feishuBotsApi.list) });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const urlProblem = (url: string): { text: string; immediate: boolean } | undefined => {
	const value = url.trim();
	if (value === "") return { text: "填写 Webhook 地址", immediate: false };
	if (/\s/.test(value)) return { text: "Webhook 地址不能含空白字符", immediate: true };
	return isHttpUrl(value)
		? undefined
		: { text: "Webhook 地址必须是 http 或 https 地址", immediate: false };
};

function WebhookField({
	value,
	onChange,
	label,
	submitted,
	autoFocus,
	inputRef,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	submitted: boolean;
	autoFocus?: boolean;
	inputRef?: React.Ref<HTMLInputElement>;
}) {
	const [left, setLeft] = useState(false);
	const problem = urlProblem(value);
	const shown = problem && (problem.immediate || left || submitted) ? problem.text : undefined;
	return (
		<FormField label={label} required error={shown}>
			{(control) => (
				<Input
					{...control}
					ref={inputRef}
					type="url"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onBlur={() => setLeft(true)}
					placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
					autoComplete="off"
					spellCheck={false}
					autoFocus={autoFocus}
					className="font-mono"
				/>
			)}
		</FormField>
	);
}

const REGISTER_HELP = `${FEISHU_BOT_SETUP.add}场景和节点按名称选择机器人。名称创建后不能修改，要换名称请新建一个再删除旧的。${FEISHU_BOT_SETUP.noSignature}`;

/** 登记一个飞书机器人：名称（创建后不能修改）和 Webhook 地址。 */
export function RegisterBotDialog({
	open,
	onOpenChange,
	focusAfter,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	focusAfter: (name: string) => HTMLElement | null;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const nameInput = useRef<HTMLInputElement>(null);
	const urlInput = useRef<HTMLInputElement>(null);
	const registered = useRef<string | null>(null);
	const invalidate = useInvalidateBots();
	const register = useMutation({
		mutationFn: (body: { name: string; webhook_url: string }) =>
			callApi(feishuBotsApi.create, { body }),
		onSuccess: async (created) => {
			registered.current = created.name;
			await invalidate();
			onOpenChange(false);
			notify.success(`已登记飞书机器人「${created.name}」`);
		},
	});
	useEffect(() => {
		if (open) {
			setName("");
			setUrl("");
			setSubmitted(false);
			registered.current = null;
			register.reset();
		}
	}, [open, register.reset]);
	const nameProblem = name.trim() === "" ? "填写机器人名称" : undefined;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				finalFocus={() => (registered.current ? focusAfter(registered.current) : null)}
			>
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						setSubmitted(true);
						if (nameProblem) nameInput.current?.focus();
						else if (urlProblem(url)) urlInput.current?.focus();
						else register.mutate({ name: name.trim(), webhook_url: url.trim() });
					}}
				>
					<DialogHeader>
						<DialogTitle>登记飞书机器人</DialogTitle>
						<DialogDescription>{REGISTER_HELP}</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<FormField label="名称" required error={submitted ? nameProblem : undefined}>
							{(control) => (
								<Input
									{...control}
									ref={nameInput}
									value={name}
									onChange={(e) => setName(e.target.value)}
									maxLength={FEISHU_BOT_NAME_MAX}
									autoComplete="off"
									autoFocus
								/>
							)}
						</FormField>
						<WebhookField
							value={url}
							onChange={setUrl}
							label="Webhook 地址"
							submitted={submitted}
							inputRef={urlInput}
						/>
						{register.isError && <FormAlert>{errorText(register.error)}</FormAlert>}
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={register.isPending}>
							登记
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** 替换 Webhook 地址：只能整个替换，页面看不到原值。 */
export function ReplaceWebhookDialog({
	bot,
	open,
	onOpenChange,
	onReplaced,
}: {
	bot: FeishuBotView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 替换成功后（旧的测试结果已经不适用）。 */
	onReplaced: () => void;
}) {
	const [url, setUrl] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const urlInput = useRef<HTMLInputElement>(null);
	const invalidate = useInvalidateBots();
	const replace = useMutation({
		mutationFn: (webhook_url: string) =>
			callApi(feishuBotsApi.replaceWebhook, { params: { name: bot.name }, body: { webhook_url } }),
		onSuccess: async () => {
			onOpenChange(false);
			onReplaced();
			notify.success(`已替换「${bot.name}」的 Webhook 地址`);
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) {
			setUrl("");
			setSubmitted(false);
			replace.reset();
		}
	}, [open, replace.reset]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						setSubmitted(true);
						if (urlProblem(url)) urlInput.current?.focus();
						else replace.mutate(url.trim());
					}}
				>
					<DialogHeader>
						<DialogTitle>替换「{bot.name}」的 Webhook 地址</DialogTitle>
						<DialogDescription>
							Webhook 地址相当于一个凭据，页面不显示原来的地址，只能整个替换。当前地址{" "}
							<span className="font-mono">{bot.webhook_url}</span>
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<WebhookField
							value={url}
							onChange={setUrl}
							label="新的 Webhook 地址"
							submitted={submitted}
							autoFocus
							inputRef={urlInput}
						/>
						{replace.isError && <FormAlert>{errorText(replace.error)}</FormAlert>}
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={replace.isPending}>
							替换
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** 一处引用的说明（场景里的哪个地方）。 */
const referenceText = (reference: FeishuBotReference): string => {
	switch (reference.kind) {
		case "feishu_notify_node":
			return `飞书通知节点 ${reference.node_id}`;
		case "feishu_bot_input":
			return `节点 ${reference.node_id} 的输入 ${reference.input}`;
		case "run_notification":
			return "运行通知（场景设置）";
	}
};

/** 引用这个机器人的场景：删除之前列出，让人知道删除会影响哪些场景。 */
function BotReferences({ bot, enabled }: { bot: FeishuBotView; enabled: boolean }) {
	const references = useQuery({
		...apiQuery(feishuBotsApi.references, { params: { name: bot.name } }),
		enabled,
	});
	if (references.isPending)
		return <p className="m-0 text-xs text-fg-3">正在查找引用这个机器人的场景…</p>;
	if (references.isError) {
		return (
			<p role="alert" className="m-0 text-xs text-danger-fg">
				无法查找引用这个机器人的场景：{errorText(references.error)}
			</p>
		);
	}
	const { scenarios } = references.data;
	const notified = scenarios.some((s) => s.references.some((r) => r.kind === "run_notification"));
	if (scenarios.length === 0) {
		return <p className="m-0 text-xs text-fg-2">没有场景引用这个机器人。</p>;
	}
	return (
		<div className="flex flex-col gap-1.5">
			<p className="m-0 text-xs text-fg-2">
				下面 {scenarios.length}{" "}
				个场景的最新版本引用了这个机器人。删除后这些节点发不出消息（飞书通知节点只在日志里留下
				warning，不影响节点和运行的结果），保存时会有警告，触发时会被拦下。
				{notified &&
					"运行通知的设置不会被改动，运行结束时在运行详情里记为「未发送：机器人已删除」，运行不受影响。"}
			</p>
			<ul aria-label="引用这个机器人的场景" className="m-0 flex list-none flex-col gap-1 p-0">
				{scenarios.map((s) => (
					<li key={s.orchestration_id} className="flex flex-col text-xs">
						<Link
							to="/orchestrations/$id"
							params={{ id: s.orchestration_id }}
							className="w-fit text-fg-1 underline underline-offset-2"
						>
							{s.name}
						</Link>
						<span className="text-fg-3">{s.references.map(referenceText).join("、")}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** 删除确认；先列出引用这个机器人的场景。 */
export function DeleteBotDialog({
	bot,
	open,
	onOpenChange,
}: {
	bot: FeishuBotView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const invalidate = useInvalidateBots();
	const remove = useMutation({
		mutationFn: () => callApi(feishuBotsApi.remove, { params: { name: bot.name } }),
		onSuccess: async () => {
			onOpenChange(false);
			notify.success(`已删除飞书机器人「${bot.name}」`);
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) remove.reset();
	}, [open, remove.reset]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>删除飞书机器人「{bot.name}」？</DialogTitle>
					<DialogDescription>
						删除后，这个名称不再对应任何机器人，之后可以用同一个名称重新登记。飞书群里的机器人不受影响。
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<BotReferences bot={bot} enabled={open} />
					{remove.isError && <FormAlert>删除失败：{errorText(remove.error)}</FormAlert>}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
						删除
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
