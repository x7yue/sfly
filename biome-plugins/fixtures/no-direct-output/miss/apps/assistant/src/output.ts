// 统一的出口自己（apps/assistant/src/output.ts）不归这条规则管：由 apps/assistant/test/output.test.ts 守。不命中。
export function writeLog(message: string): void {
	process.stderr.write(`${message}\n`);
}
