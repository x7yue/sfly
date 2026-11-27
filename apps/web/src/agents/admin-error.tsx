import { ErrorMessage } from "#/components/feedback/error-message";
import { ApiError } from "#/lib/api";
import { AGENT_ADMIN } from "#/lib/copy";

/** 控制面拒绝了这次请求：当前这个人在项目里没有「管理」范围（403）。 */
export const isForbidden = (error: unknown): boolean =>
	error instanceof ApiError && error.status === 403;

/**
 * 签发的请求出错之后，控制面**可能已经签发了**一枚、只是浏览器没拿到响应：没有收到响应（网络断了、超时）、
 * 控制面自己出错（5xx）、响应读不出来。控制面明确拒绝的（4xx：名称不合格、没有范围、没有登录）一定没有签发。
 */
export const mayHaveIssued = (error: unknown): boolean =>
	!(error instanceof ApiError) ||
	error.status === 0 ||
	error.status >= 500 ||
	error.code === "invalid_response";

/**
 * Agent 管理操作（签发、吊销、停用、恢复）出错时写在对话框里的话：没有「管理」范围（403，可能是刚被调整了角色，
 * 页面上的按钮是按打开页面时的范围显示的）写明原因；其余原样写控制面的话（经 `UntrustedText`）。
 */
export function AdminErrorText({ error }: { error: unknown }) {
	if (isForbidden(error)) return <>{AGENT_ADMIN.forbidden}</>;
	return <ErrorMessage error={error} />;
}
