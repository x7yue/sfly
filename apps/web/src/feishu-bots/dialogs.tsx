import {
	domainKey,
	FEISHU_BOT_NAME_MAX,
	type FeishuBotView,
	feishuBotsApi,
	isHttpUrl,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
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

/** Webhook 地址的输入提示：已经填了但不是 http 或 https 地址。 */
const urlProblem = (url: string): string | undefined => {
	const value = url.trim();
	if (value === "") return undefined;
	if (/\s/.test(value)) return "Webhook 地址不能含空白字符";
	return isHttpUrl(value) ? undefined : "Webhook 地址必须是 http 或 https 地址";
};

function WebhookField({
	value,
	onChange,
	label,
	autoFocus,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	autoFocus?: boolean;
}) {
	const id = useId();
	const problem = urlProblem(value);
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="text-xs text-fg-2">
				{label}
			</label>
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
				autoComplete="off"
				spellCheck={false}
				autoFocus={autoFocus}
				aria-invalid={problem !== undefined}
				className="font-mono"
			/>
			{problem && <p className="m-0 text-xs text-danger-fg">{problem}</p>}
		</div>
	);
}

const REGISTER_HELP =
	"在飞书群里添加「自定义机器人」，把它的 Webhook 地址登记到这里。场景和节点按名称选择机器人。名称创建后不能修改，要换名称请新建一个再删除旧的。sfly 不支持签名校验，机器人的安全设置请用关键词或 IP 白名单。";

/** 登记一个飞书机器人：名称（创建后不能修改）和 Webhook 地址。 */
export function RegisterBotDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const invalidate = useInvalidateBots();
	const nameId = useId();
	const register = useMutation({
		mutationFn: (body: { name: string; webhook_url: string }) =>
			callApi(feishuBotsApi.create, { body }),
		onSuccess: async (created) => {
			onOpenChange(false);
			notify.success(`已登记飞书机器人「${created.name}」`);
			await invalidate();
		},
	});
	useEffect(() => {
		if (open) {
			setName("");
			setUrl("");
			register.reset();
		}
	}, [open, register.reset]);
	const valid = name.trim() !== "" && url.trim() !== "" && urlProblem(url) === undefined;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (valid) register.mutate({ name: name.trim(), webhook_url: url.trim() });
					}}
				>
					<DialogHeader>
						<DialogTitle>登记飞书机器人</DialogTitle>
						<DialogDescription>{REGISTER_HELP}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1">
						<label htmlFor={nameId} className="text-xs text-fg-2">
							名称
						</label>
						<Input
							id={nameId}
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={FEISHU_BOT_NAME_MAX}
							autoComplete="off"
							autoFocus
						/>
					</div>
					<WebhookField value={url} onChange={setUrl} label="Webhook 地址" />
					{register.isError && (
						<p role="alert" className="m-0 text-xs text-danger-fg">
							{errorText(register.error)}
						</p>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={!valid || register.isPending}>
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
			replace.reset();
		}
	}, [open, replace.reset]);
	const valid = url.trim() !== "" && urlProblem(url) === undefined;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (valid) replace.mutate(url.trim());
					}}
				>
					<DialogHeader>
						<DialogTitle>替换「{bot.name}」的 Webhook 地址</DialogTitle>
						<DialogDescription>
							Webhook 地址相当于一个凭据，页面不显示原来的地址，只能整个替换。当前地址{" "}
							<span className="font-mono">{bot.webhook_url}</span>
						</DialogDescription>
					</DialogHeader>
					<WebhookField value={url} onChange={setUrl} label="新的 Webhook 地址" autoFocus />
					{replace.isError && (
						<p role="alert" className="m-0 text-xs text-danger-fg">
							{errorText(replace.error)}
						</p>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={!valid || replace.isPending}>
							替换
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** 删除确认。 */
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
		onError: (error) => notify.error("删除失败", { description: errorText(error) }),
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>删除飞书机器人「{bot.name}」？</DialogTitle>
					<DialogDescription>
						删除后，这个名称不再对应任何机器人，之后可以用同一个名称重新登记。飞书群里的机器人不受影响。
					</DialogDescription>
				</DialogHeader>
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
