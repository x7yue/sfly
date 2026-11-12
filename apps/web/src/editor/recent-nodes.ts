import { z } from "zod";
import { MAX_RECENT, pushRecent } from "./add-node";

/**
 * 添加节点菜单的「最近使用」：所有场景共用，保存在 localStorage（`itemValue` 给出的身份，最新在前）。
 */
const STORAGE_KEY = "sfly.addNode.recent";
const Stored = z.array(z.string());

export function readRecentNodes(): string[] {
	try {
		const stored = Stored.safeParse(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"));
		return stored.success ? [...new Set(stored.data)].slice(0, MAX_RECENT) : [];
	} catch {
		return [];
	}
}

export function rememberRecentNode(value: string): string[] {
	const next = pushRecent(readRecentNodes(), value);
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	return next;
}
