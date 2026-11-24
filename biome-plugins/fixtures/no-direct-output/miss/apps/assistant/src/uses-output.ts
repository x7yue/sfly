// 要打印就调用统一的出口：不命中。
import { printError, writeLog } from "./output.js";

export function report(error: unknown) {
	printError("failed", error);
	writeLog("done");
}
