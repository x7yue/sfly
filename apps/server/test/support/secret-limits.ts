import { clearSecretSetCache, secretLimits } from "../../src/logs/secrets.js";

/**
 * 在 `run` 期间把读取预算（完整的出现的段数）、自动机大小、值集合缓存大小的上限调成 `limits`（只给测试用，`secretLimits` 是可以改的对象），
 * 结束后（不论成败）还原。控制面和测试在同一个进程里，所以真实的读取出口也看得到：用几十 KB 的文字就能让一次读取用完预算。
 * 改上限的前后都清掉值集合的缓存：缓存里的值集合是按当时的上限建的（建得了、建不了），不能留给后面的用例。
 */
export async function withSecretLimits<T>(
	limits: Partial<typeof secretLimits>,
	run: () => Promise<T> | T,
): Promise<T> {
	const saved = { ...secretLimits };
	clearSecretSetCache();
	Object.assign(secretLimits, limits);
	try {
		return await run();
	} finally {
		Object.assign(secretLimits, saved);
		clearSecretSetCache();
	}
}

/** {@link withSecretLimits} 的同步版本。 */
export function withSecretLimitsSync<T>(limits: Partial<typeof secretLimits>, run: () => T): T {
	const saved = { ...secretLimits };
	clearSecretSetCache();
	Object.assign(secretLimits, limits);
	try {
		return run();
	} finally {
		Object.assign(secretLimits, saved);
		clearSecretSetCache();
	}
}
