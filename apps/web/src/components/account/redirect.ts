/**
 * 登录之后回到哪里：登录页的 `redirect` 查询参数，只认本站的路径（以 `/` 开头、不是 `//`、也不是 `/\`），
 * 别的（别的站点的地址、`javascript:`）一律回首页：登录页不是跳到任意地址的跳板。
 */
export function safeRedirect(value: unknown): string {
	if (typeof value !== "string") return "/";
	if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
	if (value === "/login" || value.startsWith("/login?") || value.startsWith("/setup")) return "/";
	return value;
}
