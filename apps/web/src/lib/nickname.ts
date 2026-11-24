import { unsafeNameProblem } from "@sfly/schema";
import { useSyncExternalStore } from "react";
import { getCurrentUser, subscribeIdentity } from "./identity";

/**
 * 浏览器昵称：第一次打开页面时填写，保存在 localStorage。只用于显示，不做鉴权。
 * 登录之后写操作的昵称由登录身份决定（用户的显示名，ADR 0029）：`getNickname()` 先看登录，没有登录才取这里存的昵称，
 * 昵称弹窗也不再出现。昵称请求头的删除在 #494。
 */
const STORAGE_KEY = "sfly.nickname";

const listeners = new Set<() => void>();

/** 浏览器里存的昵称（不看登录）。 */
export function getStoredNickname(): string | null {
	if (typeof window === "undefined") return null;
	return window.localStorage.getItem(STORAGE_KEY);
}

/** 写操作和页面上显示的昵称：登录了是用户的显示名，否则是浏览器里存的昵称。 */
export function getNickname(): string | null {
	return getCurrentUser()?.display_name ?? getStoredNickname();
}

/**
 * 昵称填得不合格的原因（没有问题时为 undefined）：空的，或者有控制字符、双向控制字符、零宽空格这类名字里不能有的字符
 * （和控制面同一个函数：`@sfly/schema` 的 `unsafeNameProblem`，报错说出第几个字符、哪个码位）。弹窗里先挡一下、说明原因，不等每个写请求都被服务端 400。
 */
export function nicknameProblem(value: string): string | undefined {
	// 先去首尾空白再查表，和控制面一致（控制面收到的昵称也是去过首尾空白的）：开头是 BOM、结尾是制表符的昵称，两边都放行。
	const trimmed = value.trim();
	if (!trimmed) return "填写昵称";
	return unsafeNameProblem("昵称", trimmed);
}

export function setNickname(nickname: string): void {
	window.localStorage.setItem(STORAGE_KEY, nickname.trim());
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const unsubscribeIdentity = subscribeIdentity(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		unsubscribeIdentity();
		window.removeEventListener("storage", onStorage);
	};
}

/**
 * 当前昵称。服务端渲染时为 undefined（还不知道），浏览器里没有填写过时为 null。
 */
export function useNickname(): string | null | undefined {
	return useSyncExternalStore(subscribe, getNickname, () => undefined);
}
