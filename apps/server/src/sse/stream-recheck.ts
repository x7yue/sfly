// 打开着的事件流定期重新检查它的凭据（ADR 0029「SSE」：登录被注销、用户被停用或凭据被吊销时，关掉受影响的事件流）。
//
// 进程内的注销、停用、吊销有立即的通知（src/auth/revocations.ts），但有的失效发生在通知够不着的地方：主机上的
// `reset-password` 命令是另一个进程，直接改库，空闲期限到了谁也没有通知。这里每隔一段时间（默认 30 秒，最迟这么久流被关）
// 把打开着的流用的登录和令牌按凭据去重，一次查询查一批（每种一次），查不到有效记录的，关掉用它们的流。
// 立即的通知保留，用来马上关；这里兜住其余所有的情形，以后新加的凭据（会话令牌、Agent 凭据）被吊销时也不用各写一套。
import type { AccessStore } from "../auth/access-store.js";
import type { Clock } from "../clock.js";
import type { Sse } from "./sse.js";

/** 多久重新检查一次，默认 30 秒：文档里写「最迟这么久之后流被关」，所以不超过 60 秒。 */
export const DEFAULT_STREAM_RECHECK_MS = 30_000;

export interface StreamRecheckOptions {
	sse: Sse;
	store: AccessStore;
	clock: Clock;
	intervalMs?: number | undefined;
	/** 检查出错（读库失败）：不关任何流（不能因为库一时连不上就把所有人的流断掉），下一轮再查；这里记一下。 */
	onError?: (error: unknown) => void;
}

/**
 * 立即检查一次，返回关了几条流（测试用；定期检查就是反复调它）。
 *
 * **只关「这次查过的」凭据里查出已经失效的**：查询是异步的，等它回来的这段时间里可能有新的流打开（用的凭据不在这次查的名单里）；
 * 这些流不能按「不在有效名单里」关掉，它们等下一次检查。否则一条刚打开的、凭据完全有效的流会被误关
 * （CI 上偶发失败的原因：#596）。
 */
export async function recheckStreams({ sse, store, clock }: StreamRecheckOptions): Promise<number> {
	const identities = sse.identities();
	const loginIds = [...new Set(identities.flatMap((i) => (i.loginId === null ? [] : [i.loginId])))];
	const tokenIds = [...new Set(identities.flatMap((i) => (i.tokenId === null ? [] : [i.tokenId])))];
	if (loginIds.length === 0 && tokenIds.length === 0) return 0;
	const live = await store.liveCredentials({ loginIds, tokenIds }, clock.now());
	const checkedLogins = new Set(loginIds);
	const checkedTokens = new Set(tokenIds);
	return sse.closeWhere(
		(stream) =>
			(stream.loginId !== null &&
				checkedLogins.has(stream.loginId) &&
				!live.loginIds.has(stream.loginId)) ||
			(stream.tokenId !== null &&
				checkedTokens.has(stream.tokenId) &&
				!live.tokenIds.has(stream.tokenId)),
	);
}

/** 开始定期检查；返回停止的函数（控制面关闭时调用）。 */
export function watchStreamCredentials(options: StreamRecheckOptions): () => void {
	let running = false;
	const timer = setInterval(() => {
		// 上一轮还没查完（库很慢）就跳过这一轮，不叠起来。
		if (running) return;
		running = true;
		recheckStreams(options)
			.catch((error) => options.onError?.(error))
			.finally(() => {
				running = false;
			});
	}, options.intervalMs ?? DEFAULT_STREAM_RECHECK_MS);
	timer.unref();
	return () => clearInterval(timer);
}
