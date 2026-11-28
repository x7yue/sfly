/**
 * 发起写操作的人。
 *
 * - `name`：显示用的名字，访问检查得出、检查过的（ADR 0029）：用户的显示名，项目令牌是令牌的名称。记进库里「作者」「触发人」
 *   这些列（列名还叫昵称：升级之前的记录是当时请求头里的昵称，#494 起不再有昵称请求头）。
 * - `via`：这次操作经哪个 AI 编程助手（没有时为 null），来自请求头 `x-sfly-client`，只是标注；名称只收 `VIA_NAME_PATTERN` 的，有 `agent/` 但名称都不合格时存固定的占位值（`VIA_UNKNOWN`），显示成「未知」。
 * - `userId`：用户的 ID；凭据没有用户（项目令牌）时为 null。
 * - `token`：经哪个令牌（令牌的名称，ADR 0029「经 …」）；用登录 Cookie 时为 null。它是检查过的，
 *   和不经校验的 `via` 分开记。
 * - `sessionId`：经哪个会话（会话令牌属于的会话，ADR 0029「经 …」记令牌和会话）；不是会话令牌的请求为 null。
 *   同样是检查过的：依据是请求带的会话令牌，不是模型在对话里怎么说，也不是 `via`。
 */
export interface Actor {
	name: string;
	via: string | null;
	userId: string | null;
	token: string | null;
	sessionId: string | null;
}
