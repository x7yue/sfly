import {
	domainKey,
	type Readiness,
	SESSION_MESSAGE_MAX_CHARS,
	type SessionDetailResponse,
	sessionsApi,
} from "@sfly/schema";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorMessage } from "#/components/feedback/error-message";
import { notify } from "#/components/feedback/notify";
import { QueryView } from "#/components/feedback/states";
import { Page, PageHeader } from "#/components/page";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { SESSION } from "#/lib/copy";
import { INLINE_LINK } from "#/lib/inline-link";
import { STATUS_POLL_MS } from "#/lib/polling";
import { isShortcut, shortcutText } from "#/lib/shortcuts";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EndSession, endMutationKey } from "./EndSession";
import { SESSION_PROJECT } from "./project";
import { READINESS_ID, ReadinessLine } from "./ReadinessLine";
import { ResultsPanel } from "./ResultsPanel";
import { SessionTimeline } from "./SessionTimeline";
import {
	announcement,
	type ComposerMode,
	composerMode,
	hasModelProblem,
	SESSION_STATUS,
	sessionStatusText,
} from "./session-text";
import { hasBehind, type TimelineItem, type TimelineState } from "./timeline";
import { LiveRunsContext, useLiveRunSet } from "./use-live-runs";
import { useSessionTimeline } from "./use-session-timeline";

/**
 * 会话页（#542、#544）：顶栏是标题、状态（排队中写排第几）和「停止」（在做、排队中时；排队中点它是移出队列）、「结束会话」，
 * 下面左边是时间线，底部是输入框（空闲时接着说，在做时发出去的是插话，排队中不能说），右边是「成果」（#547，`ResultsPanel`）。
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
	// 读到之后会话页占满外壳的主区域（页头和输入框固定，时间线自己滚）；加载中和出错照常是一个普通的页面。
	if (detail.data !== undefined) return <LiveSession key={detail.data.id} detail={detail.data} />;
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
				{() => null}
			</QueryView>
		</Page>
	);
}

/**
 * 模型此刻能不能用（没有配置、连不上，#548）：打开会话时随会话视图带来的就绪状态里有模型的问题的，之后用项目的会话列表里的那份
 * （每 5 秒查一次、窗口重新获得焦点时也查），好了页面自己恢复，不用重新打开；打开时没有问题的不再查：之后才出的问题，说话时的 503
 * 把原因写在输入框下面。助手和工作台的问题不在会话页管（助手页的就绪状态写）。
 */
function useReadiness(initial: Readiness): Readiness {
	const list = useQuery({
		...apiQuery(sessionsApi.list, { params: { project: SESSION_PROJECT } }),
		enabled: hasModelProblem(initial),
		refetchOnWindowFocus: true,
		refetchInterval: (query) =>
			query.state.data !== undefined && !hasModelProblem(query.state.data.readiness)
				? false
				: STATUS_POLL_MS,
		refetchIntervalInBackground: false,
	});
	return list.data?.readiness ?? initial;
}

function LiveSession({ detail }: { detail: SessionDetailResponse }) {
	const { state, results, loadOlder, loadingOlder, olderError, gone, syncQueue } =
		useSessionTimeline(detail);
	const navigate = useNavigate();
	/** 会话已经没有了（新建会话等第一轮结局期间点了停止，没有被碰过的会话被删掉）：回到列表。是这个错误就返回 true。 */
	const goBack = useCallback(() => {
		notify.info(SESSION.page.gone);
		void navigate({ to: "/" });
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
	const status = SESSION_STATUS[state.status];
	const said = useAnnouncement(state);
	const mode = composerMode(state);
	const readiness = useReadiness(detail.readiness);
	// 空闲的会话此刻说不了话（模型没有配置或连不上）：输入框旁写缺什么、该找谁，「发送」不可用，输入框照常可以写（和助手页一样）。
	const blocked = state.status === "idle" && hasModelProblem(readiness);
	// 哪几个运行开着事件流（最近的 2 个在跑的）：时间线上的运行卡片和成果栏里的卡片读同一个结果，同一个运行最多一条连接。
	const liveRuns = useLiveRunSet(results.runs);
	return (
		// 占满主区域：页头、输入框固定，时间线自己滚（`SessionTimeline`）。页头不会因为时间线长而滚到顶栏下面（#550）。
		// `@container`：版面按这一块自己的宽度分（外壳的侧边栏占掉一部分），不按窗口宽度。
		<LiveRunsContext.Provider value={liveRuns}>
			<div className="h-full px-8 pt-5 pb-4">
				<div className="@container mx-auto flex h-full w-full max-w-300 flex-col">
					<PageHeader
						// 会话的标题是第一句话：别人写的文字（公共的不可信文字组件处理）。
						title={detail.title}
						untrustedTitle
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
					{/* 读屏读一句：一轮结束、排到了、插话没有送到、会话被结束（时间线是逐字更新的，不整个播报）。 */}
					<output aria-live="polite" className="sr-only">
						{said}
					</output>
					{/* 左边是时间线和输入框，右边是「成果」（#547，#551）：这个会话留下的场景、运行和提交。窄到放不下两栏时（这一块不到 52rem）
				    成果收到时间线和输入框下面，自己最高占窗口高度的四成、超出的在里面滚，时间线仍然自己滚。 */}
					<div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-4 @min-[52rem]:grid-cols-[minmax(0,1fr)_18rem] @min-[52rem]:grid-rows-[minmax(0,1fr)] @min-[52rem]:gap-6">
						<div className="flex min-h-0 min-w-0 flex-col">
							<SessionTimeline
								state={state}
								onLoadOlder={() => void loadOlder()}
								loadingOlder={loadingOlder}
								olderError={olderError}
							/>
							<Composer
								id={detail.id}
								mode={mode}
								items={state.items}
								lastSeq={state.lastSeq}
								readiness={blocked ? readiness : null}
								onSent={syncQueue}
								onGone={onGone}
							/>
						</div>
						<div
							data-testid="session-results-scroll"
							className="max-h-[40dvh] min-h-0 overflow-y-auto @min-[52rem]:max-h-none"
						>
							<ResultsPanel results={results} partial={state.hasMore} />
						</div>
					</div>
				</div>
			</div>
		</LiveRunsContext.Provider>
	);
}

/**
 * 读屏的播报：状态变了、看得见却听不到的几件事（{@link announcement}）。同一句话连着出现两次时（连着两个「已停止」）在后面加一个看不见的
 * 字符，让它再播一次。打开页面时不播：前后是同一份状态。
 */
function useAnnouncement(state: TimelineState): string {
	const [said, setSaid] = useState("");
	const previous = useRef(state);
	useEffect(() => {
		const next = announcement(previous.current, state);
		previous.current = state;
		// 播报里有别人写的文字（助手写的结局原因、结束会话的人的昵称）：经 `untrustedPlain`，看不见的字符写出来。
		if (next !== null) {
			const plain = untrustedPlain(next);
			setSaid((current) => (current === plain ? `${plain}\u200b` : plain));
		}
	}, [state]);
	return said;
}

/** 会话页的输入框（「停止」的 data-focus-successor 指向它）。 */
const COMPOSER_SELECTOR = "[data-session-composer]";

/**
 * 「停止」：在做时停止这一轮；排队中是移出队列（这句话不会交给助手）；**有话排在这一轮后面**（停止途中说的，时间线上标「排在这一轮后面」）
 * 时控制面的 `stop` 做的是撤掉那句话，按钮的字和提示就写「撤掉排着的话」。这只由时间线的状态定（`behind`），和是谁、在哪个标签页点的
 * 停止、请求还在不在路上无关：刷新之后、另一个标签页、另一个人看到的都一样。
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
	const request = (failed: string) => ({
		mutationFn: () => callApi(sessionsApi.stop, { params: { id } }),
		onError: (error: Error) => {
			if (onGone(error)) return;
			notify.error(failed, { description: error.message });
		},
	});
	// 两个请求各自的在路上：停止的请求还没回来时有话排到了后面，这时点「撤掉排着的话」是另一个请求，不被前一个挡住；
	// 失败的提示也各写各的（撤掉没有成功时这一轮其实还在停止，不能写「无法停止这一轮」）。
	const stop = useMutation(request(SESSION.page.stopFailed));
	const cancel = useMutation(request(SESSION.page.cancelFailed));
	const action = behind ? cancel : stop;
	return (
		<Button
			size="sm"
			title={
				behind
					? SESSION.page.cancelBehindTitle
					: queued
						? SESSION.page.stopQueuedTitle
						: SESSION.page.stopTitle
			}
			// 请求在路上时不可点，但保留焦点（aria-disabled，不是 disabled 属性）：浏览器会让被禁用的按钮失去焦点，
			// 之后按钮随这一轮消失时就没有焦点可交接了；停止失败后按钮恢复可点，焦点也还在它上面。
			disabled={action.isPending}
			focusableWhenDisabled
			className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
			onClick={() => action.mutate()}
			// 这一轮结束时这个按钮随之消失：焦点交给输入框（components/focus-recovery）。
			data-focus-successor={COMPOSER_SELECTOR}
		>
			{behind
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
	items,
	lastSeq,
	readiness,
	onSent,
	onGone,
}: {
	id: string;
	mode: ComposerMode;
	items: readonly TimelineItem[];
	lastSeq: number;
	/** 助手此刻不能用（模型有问题，空闲的会话说不了话）时的就绪状态：缺什么、该找谁写在输入框下面，「发送」不可用，输入框和按钮用 aria-describedby 指向那一块；能用时为 null。 */
	readiness: Readiness | null;
	/** 空闲的会话说完话之后：核对一次状态（排上了队时控制面可能没有推 `turn_queued`）；参数是发出这句话时页面上最大的序号。 */
	onSent: (after: number) => void;
	onGone: (error: unknown) => boolean;
}) {
	const client = useQueryClient();
	const [text, setText] = useState("");
	/** 发出去、没有得到回应（503、断网）的那一句和发出时时间线的最大序号：它之后时间线上出现同样的一句，就是这句话已经记下了。 */
	const [unconfirmed, setUnconfirmed] = useState<{ text: string; after: number } | null>(null);
	const [recorded, setRecorded] = useState(false);
	const sentAfter = useRef(lastSeq);
	const field = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	const ending = useIsMutating({ mutationKey: endMutationKey(id) }) > 0;
	const send = useMutation({
		mutationFn: (message: string) =>
			callApi(sessionsApi.message, { params: { id }, body: { text: message } }),
		onSuccess: (_result, message) => {
			if (mode.kind === "send") onSent(sentAfter.current);
			// 只去掉发出去的那一句：请求在路上时输入框还能写（焦点就在里面），这时接着写的字不能一起清掉。输入框里开头已经
			// 不是发出去的那一句（用户改过它）时不动：宁可留着，也不删用户的字。
			setText((current) =>
				current.startsWith(message) ? current.slice(message.length).trimStart() : current,
			);
			void client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) });
		},
		onError: (error, message) => {
			if (onGone(error)) return;
			// 控制面可能已经把这句话记在时间线上、回应才失败（助手服务没有确认：插话的 503，或者回应在路上断了）。
			setUnconfirmed({ text: message, after: sentAfter.current });
		},
	});
	// 时间线上出现了这句话：它已经记下了（带着「没有确认送到」的通知），输入框清空，说明指向时间线上的那一条；留着它，再点一次就成了第二句。
	useEffect(() => {
		if (unconfirmed === null) return;
		const onTimeline = items.some(
			(item) =>
				item.kind === "user" && item.seq > unconfirmed.after && item.text === unconfirmed.text,
		);
		if (!onTimeline) return;
		setText((current) =>
			current.startsWith(unconfirmed.text)
				? current.slice(unconfirmed.text.length).trimStart()
				: current,
		);
		setUnconfirmed(null);
		setRecorded(true);
		send.reset();
	}, [items, unconfirmed, send.reset]);
	const notReady = readiness !== null;
	const canWrite = (mode.kind === "send" || mode.kind === "steer") && !ending;
	const empty = text.trim() === "";
	const canSend = canWrite && !empty && !send.isPending && !notReady;
	const submit = () => {
		if (!canSend) return;
		// 发出的这一刻就把焦点交给输入框：「发送」随即不可用，浏览器会让被禁用的按钮失去焦点、落到 body 上
		// （点「发送」或 Tab 到「发送」按 Enter；Safari 里点按钮本来就拿不到焦点，焦点也已经在 body 上），
		// 之后没有人再把它放回来。输入框一直在、写完下一句可以接着写；发送失败时焦点在输入框、写好的话还在。
		// 之后用户自己把焦点移到别处就不再动它。
		field.current?.focus();
		sentAfter.current = lastSeq;
		setRecorded(false);
		send.mutate(text);
	};
	if (mode.kind === "ended") {
		// 会话被结束时（可能是别人结束的）输入框里还有没发出去的话：留在页面上，只读，可以复制。
		return (
			<div className="mt-3 flex flex-none flex-col gap-2">
				<p className="m-0 text-sm text-fg-3">
					{SESSION.page.ended}
					{text.trim() === "" ? "" : `。${SESSION.page.endedDraft}`}
				</p>
				{text.trim() !== "" && (
					<Textarea
						readOnly
						data-testid="ended-draft"
						aria-label={SESSION.page.draftLabel}
						value={text}
						rows={2}
					/>
				)}
			</div>
		);
	}
	const hint = mode.kind === "steer" && !ending;
	const note = ending ? (
		SESSION.page.endingNote
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
			className="mt-2 flex flex-none flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<Textarea
				ref={field}
				data-session-composer
				aria-label={SESSION.page.sendLabel}
				aria-describedby={notReady ? READINESS_ID : note === null ? undefined : noteId}
				placeholder={
					ending
						? SESSION.page.endingPlaceholder
						: mode.kind === "steer"
							? SESSION.page.steerPlaceholder
							: mode.kind === "queued"
								? SESSION.page.queuedPlaceholder
								: mode.kind === "behind"
									? SESSION.page.behindPlaceholder
									: SESSION.page.sendPlaceholder
				}
				value={text}
				disabled={!canWrite}
				maxLength={SESSION_MESSAGE_MAX_CHARS}
				rows={2}
				onChange={(event) => {
					setText(event.target.value);
					setRecorded(false);
				}}
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
			{readiness !== null && <ReadinessLine readiness={readiness} />}
			<div className="flex items-center gap-3">
				<Button
					type="submit"
					variant="primary"
					title={`${mode.kind === "steer" ? SESSION.page.sendSteer : SESSION.page.send}（${shortcutText("assistant-send")}）`}
					aria-describedby={notReady ? READINESS_ID : undefined}
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
			{recorded && (
				<output data-testid="send-recorded" className="block text-sm text-fg-2">
					{SESSION.page.recorded}
				</output>
			)}
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
						<UntrustedText text={waitingFor.title} />
					</Link>
					{/* 控制台自己的字（括号、「正在做」）在隔离之外：昵称是从右到左的文字时，它们不能被带到昵称的另一边。 */}
					{SESSION.page.queuedWaitingFor.prefix}
					<UntrustedText text={waitingFor.created_by} />
					{SESSION.page.queuedWaitingFor.suffix}
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
	// 接口的错误信息一律经组件（里面可能拼着 Agent 报的原文）：`FormAlert` 只处理直接放进去的字符串。
	if (!(error instanceof ApiError)) {
		return (
			<>
				{SESSION.page.sendFailed}：<ErrorMessage error={error} />
			</>
		);
	}
	if (error.code === "turn_running") return <>{SESSION.page.turnRunning}</>;
	if (error.code === "session_queued") return <>{SESSION.page.sessionQueued}</>;
	if (error.code === "session_ended") return <>{SESSION.page.sessionEnded}</>;
	return (
		<>
			{SESSION.page.sendFailed}：<ErrorMessage error={error} />
		</>
	);
}
