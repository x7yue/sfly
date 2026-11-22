// 登录 Cookie 的写法（ADR 0029「凭据」）：HttpOnly（页面脚本读不到）、SameSite=Lax、HTTPS 下加 Secure。
// 库里只存它的哈希；这里只拼响应头，不碰数据库。
import { LOGIN_COOKIE } from "./access-guard.js";

export interface CookieOptions {
	/** 浏览器看到的是 HTTPS：公开地址是 https，或者这个请求本身是 https（直连 TLS，或反向代理带了 X-Forwarded-Proto: https）。 */
	secure: boolean;
}

const attributes = (secure: boolean) => `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

/** 下发（或续期）登录 Cookie：`maxAgeSeconds` 是空闲期限，每次续期都重新计。 */
export function loginCookieHeader(
	secret: string,
	maxAgeSeconds: number,
	{ secure }: CookieOptions,
): string {
	return `${LOGIN_COOKIE}=${secret}; ${attributes(secure)}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** 让浏览器删掉登录 Cookie。 */
export function clearLoginCookieHeader({ secure }: CookieOptions): string {
	return `${LOGIN_COOKIE}=; ${attributes(secure)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
