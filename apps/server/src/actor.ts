/**
 * 发起写操作的人。
 *
 * - `nickname`：显示用的名字。带了凭据的请求（ADR 0029）是检查过的：用户的显示名，项目令牌是令牌的名称；不带凭据的请求是
 *   请求头里的昵称，只是标注，不做校验（ADR 0004，#494 起不再有）。
 * - `via`：这次操作经哪个 AI 编程助手（没有时为 null），来自请求头 `x-sfly-client`，只是标注，名称不合格的当没有（`VIA_NAME_PATTERN`）。
 * - `userId`：用户的 ID；凭据没有用户（项目令牌）或没有带凭据时为 null。
 * - `token`：经哪个令牌（令牌的名称，ADR 0029「经 …」）；用登录 Cookie 或没有带凭据时为 null。它是检查过的，
 *   和不经校验的 `via` 分开记。
 * - `sessionId`：经哪个会话（会话令牌属于的会话，ADR 0029「经 …」记令牌和会话）；不是会话令牌的请求为 null。
 *   同样是检查过的：依据是请求带的会话令牌，不是模型在对话里怎么说，也不是 `via`。
 */
export interface Actor {
	nickname: string;
	via: string | null;
	userId: string | null;
	token: string | null;
	sessionId: string | null;
}
