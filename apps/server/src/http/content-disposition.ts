/** `Content-Disposition: attachment`，文件名按 RFC 6266 / 5987 同时给出 ASCII 回退和 UTF-8 版本。 */
export function attachment(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
	const utf8 = encodeURIComponent(filename).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
