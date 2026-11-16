/** 文本的前 `max` 个字符（按 Unicode 码点数，不切开代理对）；不超过时原样返回。 */
export function clipChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return Array.from(text).slice(0, max).join("");
}
