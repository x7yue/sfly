import { useSyncExternalStore } from "react";

/**
 * 浏览器昵称：第一次打开页面时填写，保存在 localStorage；每个 API 请求都通过
 * `x-sfly-nickname` 请求头携带（值用 encodeURIComponent 编码）。只用于显示，不做鉴权。
 */
export const NICKNAME_HEADER = "x-sfly-nickname";
const STORAGE_KEY = "sfly.nickname";

const listeners = new Set<() => void>();

export function getNickname(): string | null {
	if (typeof window === "undefined") return null;
	return window.localStorage.getItem(STORAGE_KEY);
}

export function setNickname(nickname: string): void {
	window.localStorage.setItem(STORAGE_KEY, nickname.trim());
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

/**
 * 当前昵称。服务端渲染时为 undefined（还不知道），浏览器里没有填写过时为 null。
 */
export function useNickname(): string | null | undefined {
	return useSyncExternalStore(subscribe, getNickname, () => undefined);
}
