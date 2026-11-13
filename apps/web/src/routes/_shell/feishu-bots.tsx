import {
	type FeishuBotView,
	type FeishuLastDelivery,
	type FeishuTestResult,
	feishuBotsApi,
} from "@sfly/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useState } from "react";
import { notify } from "#/components/feedback/notify";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { StatusPill } from "#/components/status";
import { DeleteBotDialog, RegisterBotDialog, ReplaceWebhookDialog } from "#/feishu-bots/dialogs";
import { apiQuery, callApi } from "#/lib/api";
import { DELIVERY, FEISHU_BOT_SETUP, PAGE } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import { STATUS_POLL_MS } from "#/lib/polling";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_shell/feishu-bots")({
	staticData: { crumb: PAGE.feishuBots },
	component: FeishuBotsPage,
});

const botRowPrimary = (name: string) =>
	document.querySelector<HTMLElement>(`[data-bot="${CSS.escape(name)}"] [data-list-primary]`);

/**
 * 飞书机器人管理页（ADR 0020）：登记、替换 Webhook 地址、删除、发送测试消息；
 * 每个机器人显示最近一次投递的时间和结果，以及积压（还在排队的消息）的条数，定时重新查询。
 */
function FeishuBotsPage() {
	const bots = useQuery({ ...apiQuery(feishuBotsApi.list), refetchInterval: STATUS_POLL_MS });
	const [registering, setRegistering] = useState(false);
	return (
		<Page>
			<PageHeader
				title={PAGE.feishuBots}
				count={bots.data?.bots.length}
				actions={
					bots.data &&
					bots.data.bots.length > 0 && (
						<Button variant="primary" onClick={() => setRegistering(true)}>
							登记机器人
						</Button>
					)
				}
			/>
			<Panel>
				<QueryView
					query={bots}
					loading={<TableSkeleton columns={7} />}
					errorTitle="无法加载飞书机器人"
					isEmpty={(d) => d.bots.length === 0}
					empty={
						<EmptyState
							icon={<BotIcon />}
							title="还没有登记飞书机器人"
							description={`${FEISHU_BOT_SETUP.add}通知由控制面直接发给飞书，Agent 不需要访问外网。${FEISHU_BOT_SETUP.noSignature}`}
						>
							<Button variant="primary" onClick={() => setRegistering(true)}>
								登记机器人
							</Button>
						</EmptyState>
					}
				>
					{(data) => <BotTable bots={data.bots} />}
				</QueryView>
			</Panel>
			<RegisterBotDialog
				open={registering}
				onOpenChange={setRegistering}
				focusAfter={botRowPrimary}
			/>
		</Page>
	);
}

function BotTable({ bots }: { bots: FeishuBotView[] }) {
	return (
		<Table aria-label="飞书机器人列表">
			<TableHeader>
				<TableRow>
					<TableHead width="fit">名称</TableHead>
					<TableHead width="fit">Webhook 地址</TableHead>
					<TableHead>最近投递</TableHead>
					<TableHead width="fit">积压</TableHead>
					<TableHead width="fit">登记时间</TableHead>
					<TableHead>测试结果</TableHead>
					<TableHead width="fit">
						<span className="sr-only">操作</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{bots.map((bot) => (
					<BotRow key={bot.name} bot={bot} />
				))}
			</TableBody>
		</Table>
	);
}

function BotRow({ bot }: { bot: FeishuBotView }) {
	const [replacing, setReplacing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	// 测试结果只在这个页面里显示：不经过发送队列，也不保存。
	const test = useMutation({
		mutationFn: () => callApi(feishuBotsApi.test, { params: { name: bot.name } }),
		onError: (error) => notify.error("发送测试消息失败", { description: error.message }),
	});
	return (
		<TableRow data-list-item="" data-bot={bot.name}>
			<TableCell width="fit" className="font-mono font-semibold">
				{bot.name}
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-2">
				{bot.webhook_url}
			</TableCell>
			<TableCell className="text-xs">
				<LastDelivery delivery={bot.last_delivery} />
			</TableCell>
			<TableCell width="fit">
				<Backlog count={bot.backlog} />
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-3">
				{formatDateTime(bot.created_at)}
			</TableCell>
			<TableCell className="text-xs">
				<div aria-live="polite">
					{test.isPending ? (
						<StatusPill kind="running">发送中</StatusPill>
					) : test.data ? (
						<TestResult result={test.data} />
					) : (
						<span className="text-fg-3">未测试</span>
					)}
				</div>
			</TableCell>
			<TableCell width="fit" className="text-right">
				<div className="flex justify-end gap-1.5">
					<Button
						size="sm"
						data-list-primary
						disabled={test.isPending}
						onClick={() => test.mutate()}
					>
						发送测试消息
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
						替换地址
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
						删除
					</Button>
				</div>
				<ReplaceWebhookDialog
					bot={bot}
					open={replacing}
					onOpenChange={setReplacing}
					onReplaced={() => test.reset()}
				/>
				<DeleteBotDialog bot={bot} open={deleting} onOpenChange={setDeleting} />
			</TableCell>
		</TableRow>
	);
}

/**
 * 最近一次投递：控制面每向飞书发一次请求记一次，所以一条消息还在重试时这里已经是失败（积压里能看到它在排队）。
 * 失败写着中文原因和下一步。
 */
function LastDelivery({ delivery }: { delivery: FeishuLastDelivery | null }) {
	if (!delivery) return <span className="text-fg-3">尚无投递</span>;
	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex items-center gap-2">
				<StatusPill kind={delivery.ok ? "ok" : "failed"}>
					{delivery.ok ? DELIVERY.delivered : DELIVERY.failed}
				</StatusPill>
				<span className="font-mono text-2xs text-fg-3">{formatDateTime(delivery.at)}</span>
			</div>
			{delivery.message && <div className="text-fg-1">{delivery.message}</div>}
		</div>
	);
}

/** 积压：还在排队、没有结果的消息条数（包括等着重试的）；有积压时用警告色。 */
function Backlog({ count }: { count: number }) {
	if (count === 0) return <span className="font-mono text-xs text-fg-3">0</span>;
	return <StatusPill kind="warn">{count} 条</StatusPill>;
}

/** 测试消息的结果：成功，或失败的中文原因、下一步和飞书的错误码。 */
function TestResult({ result }: { result: FeishuTestResult }) {
	if (result.ok) return <StatusPill kind="ok">{result.message}</StatusPill>;
	const codes = [
		result.feishu_code !== null && `飞书错误码 ${result.feishu_code}`,
		result.http_status !== null && `HTTP ${result.http_status}`,
	].filter(Boolean);
	return (
		<div className="flex flex-col gap-0.5">
			<StatusPill kind="failed">测试失败</StatusPill>
			<div className="text-fg-1">{result.message}</div>
			{result.next_step && <div className="text-fg-2">下一步：{result.next_step}</div>}
			{codes.length > 0 && <div className="font-mono text-2xs text-fg-3">{codes.join(" · ")}</div>}
		</div>
	);
}
