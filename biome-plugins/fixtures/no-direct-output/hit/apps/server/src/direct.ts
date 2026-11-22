// 一般的打印：控制台的各个函数都要拦，不只是 console.error。
export function plain(error: unknown) {
	// @hit
	console.error("failed", error);
	// @hit
	console.warn("careful");
	// @hit
	console.log("info");
}

// 起别名、把 console 交给别人：换个名字拿到打印的函数，规则看的是 console 这个名字本身。
// @hit
const log = console.error;
export const aliased = (error: unknown) => log("failed", error);
// @hit
export const passAround = (use: (sink: Console) => void) => use(console);

// 直接写标准错误、标准输出。
export function raw(text: string) {
	// @hit
	process.stderr.write(text);
	// @hit
	process.stdout.write(text);
}
