import {
	domainKey,
	SESSION_MESSAGE_MAX_CHARS,
	type SessionDetailResponse,
	type SessionStatus,
	sessionsApi,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { notify } from "#/components/feedback/notify";
import { QueryView } from "#/components/feedback/states";
import { Page, PageHeader } from "#/components/page";
import { StatusPill } from "#/components/status";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { SESSION } from "#/lib/copy";
import { errorText } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SESSION_PROJECT } from "./project";
import { SessionTimeline } from "./SessionTimeline";
import { SESSION_STATUS, turnEndText } from "./session-text";
import { useSessionTimeline } from "./use-session-timeline";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * 会话页（#542）：顶栏是标题、状态和（在做时的）「停止」，下面是时间线，底部是「接着说」的输入框。
 * 每次打开都重新读历史（不用缓存里的旧数据）：事件流只补打开之后的。
 */
export function SessionPage({ id }: { id: string }) {
	const detail = useQuery({
		...apiQuery(sessionsApi.get, { params: { id }, query: {} }),
		// 事件流负责之后的更新：这份历史只在打开时读一次。
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	});
	return (
		<Page>
			<QueryView
				query={detail}
				loading={
					<output aria-busy="true" className="flex flex-col gap-3">
						<Skeleton className="h-6 w-1/3" />
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</output>
				}
				errorTitle={SESSION.page.loadFailed}
			>
				{(data) => <LiveSession key={data.id} detail={data} />}
			</QueryView>
		</Page>
	);
}

function LiveSession({ detail }: { detail: SessionDetailResponse }) {
	const { state, loadOlder, loadingOlder, olderError } = useSessionTimeline(detail);
	const last = state.items.at(-1);
	useStickToBottom(
		`${state.items.length}:${last?.kind === "assistant" ? last.text.length : ""}:${state.thinking}`,
	);
	const status = SESSION_STATUS[state.status];
	const lastEnd = [...state.items].reverse().find((item) => item.kind === "turn_end");
	return (
		<div className="mx-auto flex w-full max-w-208 flex-col">
			<PageHeader
				title={detail.title}
				actions={
					<>
						<StatusPill kind={status.kind} pulse className="text-sm">
							<span data-testid="session-status" data-status={state.status}>
								{status.label}
							</span>
						</StatusPill>
						{state.status === "running" && <StopButton id={detail.id} />}
					</>
				}
			/>
			{/* 一轮结束时读屏读一句（时间线是逐字更新的，不整个播报）。 */}
			<output aria-live="polite" className="sr-only">
				{lastEnd?.kind === "turn_end" ? turnEndText(lastEnd) : ""}
			</output>
			<SessionTimeline
				state={state}
				onLoadOlder={() => void loadOlder()}
				loadingOlder={loadingOlder}
				olderError={olderError}
			/>
			<Composer id={detail.id} status={state.status} />
		</div>
	);
}

function StopButton({ id }: { id: string }) {
	const stop = useMutation({
		mutationFn: () => callApi(sessionsApi.stop, { params: { id } }),
		onError: (error) => notify.error(SESSION.page.stopFailed, { description: error.message }),
	});
	return (
		<Button
			size="sm"
			title={SESSION.page.stopTitle}
			disabled={stop.isPending}
			onClick={() => stop.mutate()}
		>
			{SESSION.page.stop}
		</Button>
	);
}

/** 底部的输入框：空闲时「接着说」，在做时不可用并写明原因，已结束时不显示。 */
function Composer({ id, status }: { id: string; status: SessionStatus }) {
	const client = useQueryClient();
	const [text, setText] = useState("");
	const send = useMutation({
		mutationFn: (message: string) =>
			callApi(sessionsApi.message, { params: { id }, body: { text: message } }),
		onSuccess: () => {
			setText("");
			void client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) });
		},
	});
	if (status === "ended") {
		return <p className="mt-4 text-sm text-fg-3">{SESSION.page.ended}</p>;
	}
	const blocked =
		status === "running" ? SESSION.page.running : status === "queued" ? SESSION.page.queued : null;
	const empty = text.trim() === "";
	return (
		<form
			aria-label={SESSION.page.sendLabel}
			className="sticky bottom-0 mt-4 flex flex-col gap-2 bg-bg pt-2 pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (blocked === null && !empty && !send.isPending) send.mutate(text);
			}}
		>
			<Textarea
				aria-label={SESSION.page.sendLabel}
				placeholder={SESSION.page.sendPlaceholder}
				value={text}
				maxLength={SESSION_MESSAGE_MAX_CHARS}
				rows={2}
				disabled={blocked !== null}
				onChange={(event) => setText(event.target.value)}
			/>
			<div className="flex items-center gap-3">
				<Button
					type="submit"
					variant="primary"
					disabled={blocked !== null || empty || send.isPending}
				>
					{send.isPending ? SESSION.page.sending : SESSION.page.send}
				</Button>
				{blocked !== null && (
					<span data-testid="composer-blocked" className="text-sm text-fg-3">
						{blocked}
					</span>
				)}
			</div>
			{send.isError && (
				<FormAlert>
					<SendError error={send.error} sessionId={id} />
				</FormAlert>
			)}
		</form>
	);
}

/**
 * 「接着说」失败的原因：这个会话有一轮在做（`turn_running`）；同一个项目另一个会话在做（`project_busy`，给出那个会话的链接）；
 * 其余（包括助手没有开启、连不上的 503）写接口给的那句话。
 */
function SendError({ error, sessionId }: { error: Error; sessionId: string }) {
	if (!(error instanceof ApiError)) return <>{`${SESSION.page.sendFailed}：${errorText(error)}`}</>;
	if (error.code === "turn_running") return <>{SESSION.page.turnRunning}</>;
	if (error.code === "project_busy") return <ProjectBusy sessionId={sessionId} />;
	return <>{`${SESSION.page.sendFailed}：${errorText(error)}`}</>;
}

/** 同一个项目另一个会话在做：写明原因，找得到是哪一个时给出它的链接（列表只在这时才读）。 */
function ProjectBusy({ sessionId }: { sessionId: string }) {
	const list = useQuery(apiQuery(sessionsApi.list, { params: { project: SESSION_PROJECT } }));
	const busy = list.data?.sessions.find(
		(session) => session.status === "running" && session.id !== sessionId,
	);
	return (
		<>
			{SESSION.busy}
			{busy && (
				<>
					{"："}
					<Link
						to="/sessions/$id"
						params={{ id: busy.id }}
						className="text-fg-1 underline underline-offset-2"
					>
						{SESSION.busyLink}
					</Link>
				</>
			)}
		</>
	);
}
