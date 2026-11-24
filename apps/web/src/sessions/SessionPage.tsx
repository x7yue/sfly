import {
	domainKey,
	SESSION_MESSAGE_MAX_CHARS,
	type SessionDetailResponse,
	type SessionStatus,
	sessionsApi,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { QueryView } from "#/components/feedback/states";
import { Page, PageHeader } from "#/components/page";
import { StatusPill } from "#/components/status";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { SESSION } from "#/lib/copy";
import { errorText } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import { isShortcut, shortcutText } from "#/lib/shortcuts";
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

/** 会话页的输入框（「停止」的 data-focus-successor 指向它）。 */
const COMPOSER_SELECTOR = "[data-session-composer]";

function StopButton({ id }: { id: string }) {
	const stop = useMutation({
		mutationFn: () => callApi(sessionsApi.stop, { params: { id } }),
		onError: (error) => notify.error(SESSION.page.stopFailed, { description: error.message }),
	});
	return (
		<Button
			size="sm"
			title={SESSION.page.stopTitle}
			// 请求在路上时不可点，但保留焦点（aria-disabled，不是 disabled 属性）：浏览器会让被禁用的按钮失去焦点，
			// 之后按钮随这一轮消失时就没有焦点可交接了；停止失败后按钮恢复可点，焦点也还在它上面。
			disabled={stop.isPending}
			focusableWhenDisabled
			className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
			onClick={() => stop.mutate()}
			// 这一轮结束时这个按钮随之消失：焦点交给输入框（components/focus-recovery）。
			data-focus-successor={COMPOSER_SELECTOR}
		>
			{stop.isPending ? SESSION.page.stopping : SESSION.page.stop}
		</Button>
	);
}

/**
 * 底部的输入框：空闲时「接着说」；在做时照常可以写下一句、只是不能发（「发送」不可用，Ctrl/⌘+Enter 同样不发；原因写在按钮旁边，
 * 输入框用 `aria-describedby` 指向它）。「输入框照常可以写」和助手页一致；原因的写法不同：助手页的原因是就绪状态里逐条的缺什么，
 * 只在页面上方写一处（按钮和输入框都指向那里，旁边不重复），这里的原因只有「在做」「排队中」一句，就写在「发送」旁边。
 * Ctrl/⌘+Enter 只在输入框里发送；点「停止」的按钮随这一轮消失时焦点交给输入框（`data-focus-successor`，不落在 body 上）；已结束时不显示。
 */
function Composer({ id, status }: { id: string; status: SessionStatus }) {
	const client = useQueryClient();
	const [text, setText] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const blockedId = useId();
	const send = useMutation({
		mutationFn: (message: string) =>
			callApi(sessionsApi.message, { params: { id }, body: { text: message } }),
		onSuccess: (_session, message) => {
			// 只去掉发出去的那一句：请求在路上时输入框还能写（焦点就在里面），这时接着写的字不能一起清掉。输入框里开头已经
			// 不是发出去的那一句（用户改过它）时不动：宁可留着，也不删用户的字。
			setText((current) =>
				current.startsWith(message) ? current.slice(message.length).trimStart() : current,
			);
			void client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) });
		},
	});
	const blocked =
		status === "running" ? SESSION.page.running : status === "queued" ? SESSION.page.queued : null;
	const empty = text.trim() === "";
	const canSend = blocked === null && !empty && !send.isPending;
	const submit = () => {
		if (!canSend) return;
		// 发出的这一刻就把焦点交给输入框：「发送」随即不可用，浏览器会让被禁用的按钮失去焦点、落到 body 上
		// （点「发送」或 Tab 到「发送」按 Enter；Safari 里点按钮本来就拿不到焦点，焦点也已经在 body 上），
		// 之后没有人再把它放回来。输入框一直在、写完下一句可以接着写；发送失败时焦点在输入框、写好的话还在。
		// 之后用户自己把焦点移到别处就不再动它。
		field.current?.focus();
		send.mutate(text);
	};
	if (status === "ended") {
		return <p className="mt-4 text-sm text-fg-3">{SESSION.page.ended}</p>;
	}
	return (
		<form
			aria-label={SESSION.page.sendLabel}
			className="sticky bottom-0 mt-4 flex flex-col gap-2 bg-bg pt-2 pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<Textarea
				ref={field}
				data-session-composer
				aria-label={SESSION.page.sendLabel}
				aria-describedby={blocked === null ? undefined : blockedId}
				placeholder={SESSION.page.sendPlaceholder}
				value={text}
				maxLength={SESSION_MESSAGE_MAX_CHARS}
				rows={2}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					// Ctrl/⌘+Enter 只在输入框里发送（登记在快捷键面板里，但不是全局快捷键）；输入法选字时的 Enter 不算
					// （keyCode 229：Safari 在组字结束的那次按键上 isComposing 已经是 false）。
					if (
						isShortcut("assistant-send", event) &&
						!(event.nativeEvent.isComposing || event.keyCode === 229)
					) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			<div className="flex items-center gap-3">
				<Button
					type="submit"
					variant="primary"
					title={`${SESSION.page.send}（${shortcutText("assistant-send")}）`}
					disabled={blocked !== null || empty || send.isPending}
				>
					{send.isPending ? SESSION.page.sending : SESSION.page.send}
				</Button>
				{blocked !== null && (
					<span id={blockedId} data-testid="composer-blocked" className="text-sm text-fg-3">
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
					<Link to="/sessions/$id" params={{ id: busy.id }} className={INLINE_LINK}>
						{SESSION.busyLink}
					</Link>
				</>
			)}
		</>
	);
}
