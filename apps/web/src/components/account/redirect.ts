/**
 * 登录之后回到哪里：登录页的 `redirect` 查询参数，只认本站的路径：以 `/` 开头、不是 `//`，整个字符串里没有反斜杠和控制字符
 * （制表符、换行等：浏览器和路由库会把它们去掉或换成别的写法，`/\t/evil.example` 去掉制表符就是 `//evil.example`），
 * 别的（别的站点的地址、`javascript:`）一律回首页：登录页不是跳到任意地址的跳板。这一步自己就拒绝，不靠路由库兜底。
 */
export function safeRedirect(value: unknown): string {
	if (typeof value !== "string") return "/";
	if (!value.startsWith("/") || value.startsWith("//")) return "/";
	// 反斜杠（浏览器把 `/\` 当 `//`）和控制字符（U+0000–U+001F、U+007F）。
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 要的就是控制字符
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
	if (value === "/login" || value.startsWith("/login?") || value.startsWith("/setup")) return "/";
	return value;
}
