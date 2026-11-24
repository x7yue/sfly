import {
	domainKey,
	type Readiness,
	SESSION_MESSAGE_MAX_CHARS,
	type SessionListItem,
	sessionsApi,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, callApi } from "#/lib/api";
import { SESSION } from "#/lib/copy";
import { errorText } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import { isShortcut, shortcutText } from "#/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { busySession, SESSION_PROJECT } from "./project";
import { READINESS_ID } from "./ReadinessLine";

/**
 * 助手页的输入框：多行输入「要做什么？」和「开始」（`POST /projects/default/sessions`，成功后跳到会话页）。
 * 助手没有就绪时输入框照常可以写，「开始」不可用（原因在页面上方的就绪状态里，不在这里再写一遍）；请求失败时留住写好的话，写明原因：
 * `project_busy`（同一个项目另一个会话在做）时给出那个会话的链接。
 */
export function NewSession({
	readiness,
	sessions,
}: {
	readiness: Readiness;
	sessions: readonly SessionListItem[];
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const [text, setText] = useState("");
	const create = useMutation({
		mutationFn: (first: string) =>
			callApi(sessionsApi.create, { params: { project: SESSION_PROJECT }, body: { text: first } }),
		onSuccess: (session) => {
			void client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) });
			void navigate({ to: "/sessions/$id", params: { id: session.id } });
		},
		// 失败也刷新：就绪状态、谁在做可能已经变了。
		onError: () => client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) }),
	});
	// 不能用的原因只在页面上方的就绪状态里写一处（ReadinessLine，逐条写缺什么）；这里不再写一遍，读屏用 aria-describedby 指过去。
	const notReady = !readiness.ready;
	const empty = text.trim() === "";
	const busy = busySession(sessions);
	const field = useRef<HTMLTextAreaElement>(null);
	const start = () => {
		if (notReady || empty || create.isPending) return;
		// 开始的这一刻就把焦点交给输入框：「开始」随即不可用，浏览器会让被禁用的按钮失去焦点、落到 body 上
		// （和会话页的「发送」一样）；失败时焦点在输入框、写好的话还在。成功后跳到会话页，输入框随之没有。
		field.current?.focus();
		create.mutate(text);
	};
	return (
		<form
			aria-label={SESSION.input.label}
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				start();
			}}
		>
			<Textarea
				ref={field}
				aria-label={SESSION.input.label}
				aria-describedby={notReady ? READINESS_ID : undefined}
				placeholder={SESSION.input.placeholder}
				value={text}
				maxLength={SESSION_MESSAGE_MAX_CHARS}
				rows={3}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					// Ctrl/⌘+Enter 开始（和会话页的「接着说」同一个快捷键），只在输入框里；Enter 是换行；输入法选字时的 Enter 不算
					// （keyCode 229：Safari 在组字结束的那次按键上 isComposing 已经是 false）。
					if (
						isShortcut("assistant-send", event) &&
						!(event.nativeEvent.isComposing || event.keyCode === 229)
					) {
						event.preventDefault();
						start();
					}
				}}
			/>
			<div className="flex items-center gap-3">
				<Button
					type="submit"
					variant="primary"
					title={`${SESSION.input.start}（${shortcutText("assistant-send")}）`}
					aria-describedby={notReady ? READINESS_ID : undefined}
					disabled={notReady || empty || create.isPending}
				>
					{create.isPending ? SESSION.input.starting : SESSION.input.start}
				</Button>
			</div>
			{create.isError && (
				<FormAlert>
					{create.error instanceof ApiError && create.error.code === "project_busy" ? (
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
					) : (
						`${SESSION.createFailed}：${errorText(create.error)}`
					)}
				</FormAlert>
			)}
		</form>
	);
}
