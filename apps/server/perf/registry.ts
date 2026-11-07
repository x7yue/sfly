// 性能测试项的注册表：perf/items/ 下每个 `<两位序号>-<标识>.ts` 文件默认导出一项（definePerfItem），
// 按文件名排序。新增一项只需新建一个文件，不改这里，几个人同时新增也不会冲突。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PerfItem } from "./item.js";

const ITEMS_DIR = join(import.meta.dirname, "items");
const FILE = /^\d{2}-([a-z0-9-]+)\.ts$/;

/** 加载全部项；文件名不合规范、标识与文件名不一致或重复时抛出错误。 */
export async function loadItems(dir = ITEMS_DIR): Promise<PerfItem[]> {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
	const items: PerfItem[] = [];
	for (const file of files) {
		const match = FILE.exec(file);
		if (!match) throw new Error(`perf/items/${file}：文件名应为 <两位序号>-<标识>.ts`);
		const item = ((await import(pathToFileURL(join(dir, file)).href)) as { default?: PerfItem })
			.default;
		if (!item || item.id !== match[1]) {
			throw new Error(`perf/items/${file}：应默认导出 id 为 ${match[1]} 的项`);
		}
		if (items.some((i) => i.id === item.id)) throw new Error(`重复的项：${item.id}`);
		items.push(item);
	}
	return items;
}

/** 按 `--only` 选出项（按给定顺序）；null 表示全部。 */
export function selectItems<T extends { id: string }>(items: T[], only: string[] | null): T[] {
	if (!only) return items;
	const unknown = only.filter((id) => !items.some((i) => i.id === id));
	if (unknown.length > 0) {
		throw new Error(
			`不认识的项：${unknown.join(", ")}（可用：${items.map((i) => i.id).join(", ")}）`,
		);
	}
	return only.map((id) => items.find((i) => i.id === id) as T);
}
