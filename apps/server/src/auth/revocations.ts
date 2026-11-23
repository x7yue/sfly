// 凭据被吊销或失效时打开着的事件流要跟着关掉（ADR 0029「SSE」）：登录注销、用户停用、令牌吊销都从这里广播，
// 路由层据此关掉受影响的流（src/http/api.ts）。单进程，按用户、登录和令牌登记即可。

/**
 * 一批凭据被吊销或失效：
 * - `user`：这个用户的一切（停用：登录和令牌）；
 * - `logins`：这个用户的登录（`only` 只这一个，`except` 除了这一个）；
 * - `token`：这一个令牌（个人令牌、项目令牌）。
 */
export type Revocation =
	| { type: "user"; userId: string }
	| { type: "logins"; userId: string; only?: string; except?: string }
	| { type: "token"; tokenId: string };

/** 吊销的广播：账号服务和令牌服务发，路由层收。 */
export class RevocationBus {
	readonly #listeners = new Set<(revocation: Revocation) => void>();

	/** 订阅；返回取消订阅的函数。 */
	subscribe(listener: (revocation: Revocation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(revocation: Revocation): void {
		for (const listener of this.#listeners) listener(revocation);
	}
}
