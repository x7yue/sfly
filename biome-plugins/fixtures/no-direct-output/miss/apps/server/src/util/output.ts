// 统一的出口自己可以用：所有打印都经过它。
export function printError(what: string, error?: unknown): void {
	console.error(what, error);
}
export const printWarning = (message: string) => console.warn(message);
export const writeStdout = (text: string) => process.stdout.write(text);
export const writeStderr = (text: string) => process.stderr.write(text);
