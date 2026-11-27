import { makeTempDir, makeTempDirSync } from "./support/temp-dir.js";

// 经共享函数建临时目录：不拦。
export async function dirs() {
	return [await makeTempDir("sfly-a-"), makeTempDirSync("sfly-b-")];
}
