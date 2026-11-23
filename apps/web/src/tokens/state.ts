import type { TokenView } from "@sfly/schema";

/**
 * 令牌此刻的状态：控制面认的是吊销和过期两条（吊销过的、过期了的令牌立即 401），列表和吊销按钮照这个显示。
 * 吊销优先：吊销是人做的决定，又过期了也说「已吊销」。过期按「到点就失效」，和控制面的比较方向一致。
 */
export type TokenState = "active" | "expired" | "revoked";

export function tokenState(
	token: Pick<TokenView, "revoked_at" | "expires_at">,
	now: number,
): TokenState {
	if (token.revoked_at !== null) return "revoked";
	if (token.expires_at !== null && Date.parse(token.expires_at) <= now) return "expired";
	return "active";
}
