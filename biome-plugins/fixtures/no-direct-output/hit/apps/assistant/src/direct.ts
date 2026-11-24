// 助手服务（#693）：同一条规则管 apps/assistant/src，写法和控制面一样。
export function report(error: unknown) {
	// @hit
	console.error("failed", error);
}

export function raw(text: string) {
	// @hit
	process.stderr.write(text);
	// @hit
	process.stdout.write(text);
}
