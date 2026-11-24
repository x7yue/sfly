/** 文本的前 `max` 个字符（按 Unicode 码点数，不切开代理对）；不超过时原样返回。 */
export function clipChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return Array.from(text).slice(0, max).join("");
}

/**
 * 文本里前 `chars` 个字符（Unicode 码点，同 {@link clipChars}）之后的位置（UTF-16 下标）；文本不到 `chars` 个字符时是文本的长度。
 * 「原文的前 N 个字符」按这个位置算：SecretSet.maskClipped 按原文的位置截断。
 */
export function indexAfterChars(text: string, chars: number): number {
	if (text.length <= chars) return text.length;
	let at = 0;
	for (let n = 0; n < chars && at < text.length; n++) {
		at += (text.codePointAt(at) as number) > 0xffff ? 2 : 1;
	}
	return at;
}
