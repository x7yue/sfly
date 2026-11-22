import { authApi, type CurrentUser } from "@sfly/schema";
import { useSyncExternalStore } from "react";
import { ApiError, callApi } from "./api";

/**
 * 登录的身份（ADR 0029）：控制台用登录 Cookie（HttpOnly，页面脚本读不到）认人，页面只知道「当前用户是谁」，
 * 由 `GET /auth/me` 取得。在 #494 之前不登录也能照旧使用：`anonymous` 就是没有登录，用昵称。
 *
 * - `unknown`：页面刚打开，还没问过控制面；
 * - `anonymous`：没有登录（401）；
 * - `user`：已登录。
 */
export type Identity =
	| { status: "unknown" }
	| { status: "anonymous" }
	| { status: "user"; user: CurrentUser };

let identity: Identity = { status: "unknown" };
const listeners = new Set<() => void>();

function set(next: Identity): void {
	identity = next;
	for (const listener of listeners) listener();
}

export const getIdentity = (): Identity => identity;

/** 已登录的用户；没有登录或还不知道时为 null。 */
export const getCurrentUser = (): CurrentUser | null =>
	identity.status === "user" ? identity.user : null;

/** 登录、初始化成功之后调用；登出时传 null。 */
export function setCurrentUser(user: CurrentUser | null): void {
	set(user ? { status: "user", user } : { status: "anonymous" });
}

/** 问控制面当前是不是登录着：401 是没有登录；网络出错等别的失败不改变已知的状态（还是 unknown 时按没有登录）。 */
export async function refreshIdentity(): Promise<void> {
	try {
		setCurrentUser(await callApi(authApi.me));
	} catch (error) {
		if (error instanceof ApiError && error.status === 401) set({ status: "anonymous" });
		else if (identity.status === "unknown") set({ status: "anonymous" });
	}
}

/**
 * 登录失效之后做什么（空闲期限到了、被注销、被停用）：由 `main.tsx` 登记，跳到登录页并带上现在的页面。
 * 不放在这个文件里直接跳转：这里不依赖路由。
 */
let onSessionExpired: (() => void) | undefined;
export function setSessionExpiredHandler(handler: (() => void) | undefined): void {
	onSessionExpired = handler;
}

/**
 * 有请求拿到了 401（接口请求，或事件流重连）：**本来登录着**、现在不是了，就把身份改成没有登录并通知一次，
 * 页面回到登录页。一个开着的监控页悄悄停止更新（事件流拿到 401 就停了，页面上还显示着账号），比被请去重新登录糟得多。
 * 只有 `user` 才通知：从没登录过的人（昵称模式，#494 之前仍然合法）、还不知道有没有登录（页面刚打开）、
 * 登录页上登录失败的 401，都不跳转；同时到的好几个 401 只通知一次（第一个就把身份改了）。
 */
export function noteUnauthorized(): void {
	if (identity.status !== "user") return;
	set({ status: "anonymous" });
	onSessionExpired?.();
}

export function subscribeIdentity(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 当前身份；订阅它的组件在登录、登出时重新渲染。 */
export function useIdentity(): Identity {
	return useSyncExternalStore(subscribeIdentity, getIdentity, getIdentity);
}
