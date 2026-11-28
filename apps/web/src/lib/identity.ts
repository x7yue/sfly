import { authApi, type CurrentUser } from "@sfly/schema";
import { useSyncExternalStore } from "react";
import { ApiError, callApi } from "./api";

/**
 * 登录的身份（ADR 0029）：控制台用登录 Cookie（HttpOnly，页面脚本读不到）认人，页面只知道「当前用户是谁」，
 * 由 `GET /auth/me` 取得。#494 起不带凭据的请求一律 401，控制台要登录才能用。
 *
 * - `unknown`：页面刚打开，还没问过控制面；
 * - `anonymous`：没有登录（401）：页面打开时问到这个就去登录页（`main.tsx`），登录失效之后也变成它；
 * - `user`：已登录。
 */
export type Identity =
	| { status: "unknown" }
	| { status: "anonymous" }
	| { status: "user"; user: CurrentUser };

let identity: Identity = { status: "unknown" };
const listeners = new Set<() => void>();

/** 身份每变一次加一：确认登录是否失效的那次请求回来时，靠它知道问的这段时间里身份有没有变过（登出、换了一个人登录）。 */
let generation = 0;

function set(next: Identity): void {
	generation += 1;
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

/** 问控制面当前是不是登录着：401 是没有登录；网络出错等别的失败不改变已知的状态（还是 unknown 时按没有登录，去登录页）。 */
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

/** 正在向控制面确认登录是不是真的失效了；同时到的好几个 401 共用这一次。 */
let confirming = false;

/**
 * 确认请求最多等多久。笔记本合盖再打开之类的情况下请求可能挂很久，这期间 `confirming` 一直占着，之后登录真的失效了也不会跳转；
 * 到时间按「问不出结果」处理（不跳转、身份不变），下一个 401 再问。
 */
export const CONFIRM_TIMEOUT_MS = 10_000;

/**
 * 有请求拿到了 401（接口请求，或事件流重连）：**本来登录着**，先问一次 `GET /auth/me`——**确认登录真的失效了**才把身份改成
 * 没有登录并通知一次，页面回到登录页。一个开着的监控页悄悄停止更新（事件流拿到 401 就停了，页面上还显示着账号），
 * 比被请去重新登录糟得多；但 401 不一定是登录失效：公开地址和浏览器实际打开的地址不一致、又不是安全上下文时，登录有效，
 * 写请求也会被当作没登录（401），这时回到登录页，重新登录后再试又被带回去，人被困在循环里。所以只在 `GET /auth/me` 也是 401
 * 时才跳转；登录还有效（200）或者问不出结果（网络出错、一直不回）都留在原页面，这次请求的错误由页面自己显示
 * （页面上已有「请用正确的地址打开」的提示）。
 * 只有 `user` 才问：没有登录（页面打开时问到没有登录，`main.tsx` 自己去登录页）、还不知道有没有登录（页面刚打开）、
 * 登录页上登录失败的 401，都不跳转；同时到的好几个 401 只问一次、最多跳转一次。
 */
export function noteUnauthorized(): void {
	if (identity.status !== "user" || confirming) return;
	confirming = true;
	void confirmExpired().finally(() => {
		confirming = false;
	});
}

async function confirmExpired(): Promise<void> {
	// 回答是问的那一刻的 Cookie 的：问的这段时间里身份变过（登出、换了一个人登录、重新登录），答案不能用来改现在的状态——
	// 200 会把已经登出的人又显示成登录着，或者把现在登录的这个人换回前一个人；401 会把刚登录的人踢下线。以现在的状态为准，不替它改。
	const asked = generation;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let answer: CurrentUser | "expired" | "unknown";
	try {
		answer = await Promise.race([
			callApi(authApi.me),
			new Promise<"unknown">((resolve) => {
				timer = setTimeout(() => resolve("unknown"), CONFIRM_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		answer = error instanceof ApiError && error.status === 401 ? "expired" : "unknown";
	} finally {
		clearTimeout(timer);
	}
	if (generation !== asked || answer === "unknown") return;
	if (answer !== "expired") {
		setCurrentUser(answer);
		return;
	}
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
