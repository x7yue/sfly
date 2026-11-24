import {
	domainKey,
	SESSION_MESSAGE_MAX_CHARS,
	type SessionDetailResponse,
	sessionsApi,
} from "@sfly/schema";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import { EndSession, endMutationKey } from "./EndSession";
import { PeerText } from "./peer-text";
import { SessionTimeline } from "./SessionTimeline";
import {
	type ComposerMode,
	composerMode,
	SESSION_STATUS,
	sessionStatusText,
	turnEndText,
} from "./session-text";
import { hasBehind } from "./timeline";
import { useSessionTimeline } from "./use-session-timeline";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * 会话页（#542、#544）：顶栏是标题、状态（排队中写排第几）和「停止」（在做、排队中时；排队中点它是移出队列）、「结束会话」，
 * 下面是时间线，底部是输入框（空闲时接着说，在做时发出去的是插话，排队中不能说）。
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
	const { state, loadOlder, loadingOlder, olderError, gone } = useSessionTimeline(detail);
	const navigate = useNavigate();
	/** 会话已经没有了（新建会话等第一轮结局期间点了停止，没有被碰过的会话被删掉）：回到列表。是这个错误就返回 true。 */
	const goBack = useCallback(() => {
		notify.info(SESSION.page.gone);
		void navigate({ to: "/sessions" });
	}, [navigate]);
	const onGone = useCallback(
		(error: unknown) => {
			if (!(error instanceof ApiError) || error.status !== 404) return false;
			goBack();
			return true;
		},
		[goBack],
	);
	useEffect(() => {
		if (gone) goBack();
	}, [gone, goBack]);
	const last = state.items.at(-1);
	useStickToBottom(
		`${state.items.length}:${last?.kind === "assistant" ? last.text.length : ""}:${state.thinking}`,
	);
	const status = SESSION_STATUS[state.status];
	const lastEnd = [...state.items].reverse().find((item) => item.kind === "turn_end");
	const mode = composerMode(state);
	return (
		<div className="mx-auto flex w-full max-w-208 flex-col">
			<PageHeader
				title={detail.title}
				actions={
					<>
						<StatusPill kind={status.kind} pulse className="text-sm">
							<span data-testid="session-status" data-status={state.status}>
								{sessionStatusText(state)}
							</span>
						</StatusPill>
						{(state.status === "running" || state.status === "queued") && (
							<StopButton
								id={detail.id}
								queued={state.status === "queued"}
								behind={hasBehind(state.items)}
								onGone={onGone}
							/>
						)}
						{state.status !== "ended" && <EndSession id={detail.id} onGone={onGone} />}
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
			<Composer id={detail.id} mode={mode} onGone={onGone} />
		</div>
	);
}

/** 会话页的输入框（「停止」的 data-focus-successor 指向它）。 */
const COMPOSER_SELECTOR = "[data-session-composer]";

/**
 * 「停止」：在做时停止这一轮；排队中是移出队列（这句话不会交给助手）；停止途中说了话、有话排在这一轮后面时，再点一次是撤掉那句话
 * （按钮这时写「撤掉排着的话」，请求在路上也可点）。
 */
function StopButton({
	id,
	queued,
	behind,
	onGone,
}: {
	id: string;
	queued: boolean;
	behind: boolean;
	onGone: (error: unknown) => boolean;
}) {
	const stop = useMutation({
		mutationFn: () => callApi(sessionsApi.stop, { params: { id } }),
		onError: (error) => {
			if (onGone(error)) return;
			notify.error(SESSION.page.stopFailed, { description: error.message });
		},
	});
	const cancelBehind = behind && stop.isPending;
	return (
		<Button
			size="sm"
			title={
				cancelBehind
					? SESSION.page.cancelBehindTitle
					: queued
						? SESSION.page.stopQueuedTitle
						: SESSION.page.stopTitle
			}
			// 请求在路上时不可点，但保留焦点（aria-disabled，不是 disabled 属性）：浏览器会让被禁用的按钮失去焦点，
			// 之后按钮随这一轮消失时就没有焦点可交接了；停止失败后按钮恢复可点，焦点也还在它上面。有话排在后面时请求在路上也可点
			// （再点一次是撤掉那句话）。
			disabled={stop.isPending && !cancelBehind}
			focusableWhenDisabled
			className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
			onClick={() => stop.mutate()}
			// 这一轮结束时这个按钮随之消失：焦点交给输入框（components/focus-recovery）。
			data-focus-successor={COMPOSER_SELECTOR}
		>
			{cancelBehind
				? SESSION.page.cancelBehind
				: stop.isPending
					? SESSION.page.stopping
					: SESSION.page.stop}
		</Button>
	);
}

/**
 * 底部的输入框，按 {@link composerMode} 分几种：
 * - 空闲：「接着说」，开始新的一轮（项目里别的会话在做时它排队，状态由事件流推进）；
 * - 在做：照常可以发，发出去的是**插话**（时间线上标「插话」，写着送到了没有），按钮写「发送插话」，输入框下写「插话在当前这一步做完后送到；
 *   要马上停下用停止」；
 * - 停止途中说了话、有话排在这一轮后面：不能再说，写明这一轮在停止、话排在第几位、再点停止是撤掉它；
 * - 排队中：不能说，写「排在第 N 位：<会话标题>（<发起人>）正在做」，标题链到那个会话；
 * - 正在结束（请求在路上）：不能说；已结束：不显示输入框。
 * Ctrl/⌘+Enter 只在输入框里发送；点「停止」的按钮随这一轮消失时焦点交给输入框（`data-focus-successor`，不落在 body 上）。
 */
function Composer({
	id,
	mode,
	onGone,
}: {
	id: string;
	mode: ComposerMode;
	onGone: (error: unknown) => boolean;
}) {
	const client = useQueryClient();
	const [text, setText] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	const ending = useIsMutating({ mutationKey: endMutationKey(id) }) > 0;
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
		onError: (error) => {
			onGone(error);
		},
	});
	const canWrite = (mode.kind === "send" || mode.kind === "steer") && !ending;
	const empty = text.trim() === "";
	const canSend = canWrite && !empty && !send.isPending;
	const submit = () => {
		if (!canSend) return;
		// 发出的这一刻就把焦点交给输入框：「发送」随即不可用，浏览器会让被禁用的按钮失去焦点、落到 body 上
		// （点「发送」或 Tab 到「发送」按 Enter；Safari 里点按钮本来就拿不到焦点，焦点也已经在 body 上），
		// 之后没有人再把它放回来。输入框一直在、写完下一句可以接着写；发送失败时焦点在输入框、写好的话还在。
		// 之后用户自己把焦点移到别处就不再动它。
		field.current?.focus();
		send.mutate(text);
	};
	if (mode.kind === "ended") {
		return <p className="mt-4 text-sm text-fg-3">{SESSION.page.ended}</p>;
	}
	const hint = mode.kind === "steer" && !ending;
	const note = ending ? (
		SESSION.page.ending
	) : mode.kind === "steer" ? (
		SESSION.page.steerHint
	) : mode.kind === "behind" ? (
		SESSION.page.behind(mode.position)
	) : mode.kind === "queued" ? (
		<QueuedNote position={mode.position} waitingFor={mode.waitingFor} />
	) : null;
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
				aria-describedby={note === null ? undefined : noteId}
				placeholder={
					mode.kind === "steer" ? SESSION.page.steerPlaceholder : SESSION.page.sendPlaceholder
				}
				value={text}
				disabled={!canWrite}
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
					title={`${mode.kind === "steer" ? SESSION.page.sendSteer : SESSION.page.send}（${shortcutText("assistant-send")}）`}
					disabled={!canSend}
				>
					{send.isPending
						? SESSION.page.sending
						: mode.kind === "steer"
							? SESSION.page.sendSteer
							: SESSION.page.send}
				</Button>
				{note !== null && (
					<span
						id={noteId}
						data-testid={hint ? "composer-hint" : "composer-blocked"}
						className="text-sm text-fg-3"
					>
						{note}
					</span>
				)}
			</div>
			{send.isError && !(send.error instanceof ApiError && send.error.status === 404) && (
				<FormAlert>
					<SendError error={send.error} />
				</FormAlert>
			)}
		</form>
	);
}

/** 排队中：「排在第 N 位：<标题>（<发起人>）正在做」，标题链到正在做的那个会话；没有会话在做（等兜底开始）时写等助手空出来。 */
function QueuedNote({
	position,
	waitingFor,
}: {
	position: number | null;
	waitingFor: NonNullable<ComposerMode & { kind: "queued" }>["waitingFor"];
}) {
	return (
		<>
			{position === null ? "" : SESSION.page.queuedBefore(position)}
			{waitingFor === null ? (
				SESSION.page.queuedNobody
			) : (
				<>
					<Link
						to="/sessions/$id"
						params={{ id: waitingFor.session_id }}
						className={INLINE_LINK}
						title={SESSION.page.queuedOpen}
					>
						<PeerText>{waitingFor.title}</PeerText>
					</Link>
					<PeerText>{SESSION.page.queuedWaitingFor(waitingFor.created_by)}</PeerText>
				</>
			)}
		</>
	);
}

/**
 * 「接着说」失败的原因：这个会话有一轮在做、而控制面看来已经结束了（`turn_running`）；会话在排队（`session_queued`）；会话已经结束
 * 或者正在结束（`session_ended`）；其余（包括助手没有开启、连不上的 503）写接口给的那句话。
 */
function SendError({ error }: { error: Error }) {
	if (!(error instanceof ApiError)) return <>{`${SESSION.page.sendFailed}：${errorText(error)}`}</>;
	if (error.code === "turn_running") return <>{SESSION.page.turnRunning}</>;
	if (error.code === "session_queued") return <>{SESSION.page.sessionQueued}</>;
	if (error.code === "session_ended") return <>{SESSION.page.sessionEnded}</>;
	return <>{`${SESSION.page.sendFailed}：${errorText(error)}`}</>;
}
