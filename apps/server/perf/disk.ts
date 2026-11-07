// 负载测试里的磁盘测量：目录的实际占用（按分配的块计算）与定时采样，列出目录里的文件大小。
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** 文件或目录已经不在了（任务目录被清理、日志副本轮换时改名）：测量时跳过它。 */
const vanished = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT" ||
	(error as NodeJS.ErrnoException).code === "ENOTDIR";

/** 目录（递归，不跟随符号链接）实际占用的字节数：分配的块数 × 512，与 `du` 一致；FIFO、空文件不占块。 */
export async function dirUsage(path: string): Promise<number> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(path);
	} catch (error) {
		if (vanished(error)) return 0;
		throw error;
	}
	let bytes = stat.blocks * 512;
	if (stat.isDirectory()) {
		let names: string[];
		try {
			names = await readdir(path);
		} catch (error) {
			if (vanished(error)) return bytes;
			throw error;
		}
		for (const name of names) bytes += await dirUsage(join(path, name));
	}
	return bytes;
}

/** 目录里的普通文件（不递归）及其大小；目录不存在时为空。 */
export async function listFiles(dir: string): Promise<Array<{ name: string; size: number }>> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (vanished(error)) return [];
		throw error;
	}
	const files: Array<{ name: string; size: number }> = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		try {
			files.push({ name: entry.name, size: (await lstat(join(dir, entry.name))).size });
		} catch (error) {
			if (!vanished(error)) throw error;
		}
	}
	return files;
}

/** 目录里的子目录（不递归，绝对路径）；目录不存在时为空。 */
export async function listDirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
	} catch (error) {
		if (vanished(error)) return [];
		throw error;
	}
}

/**
 * 按固定间隔调用 `measure`（上一次没结束时跳过这一拍），记下 `{ ms: Date.now(), value }`；
 * stop() 等最后一次结束并再测一次，返回全部采样。采样用墙上时间，方便与控制面记录的任务开始、结束时间对齐。
 */
export function sampleEvery<T>(measure: () => Promise<T>, intervalMs: number) {
	const samples: Array<{ ms: number; value: T }> = [];
	let pending: Promise<void> | undefined;
	let failure: unknown;
	const tick = () => {
		if (pending) return;
		pending = measure()
			.then((value) => {
				samples.push({ ms: Date.now(), value });
			})
			.catch((error: unknown) => {
				failure ??= error;
			})
			.finally(() => {
				pending = undefined;
			});
	};
	tick();
	const timer = setInterval(tick, intervalMs);
	return {
		async stop(): Promise<Array<{ ms: number; value: T }>> {
			clearInterval(timer);
			await pending;
			tick();
			await pending;
			if (failure) throw failure;
			return samples;
		},
	};
}
