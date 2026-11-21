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

export function subscribeIdentity(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 当前身份；订阅它的组件在登录、登出时重新渲染。 */
export function useIdentity(): Identity {
	return useSyncExternalStore(subscribeIdentity, getIdentity, getIdentity);
}
