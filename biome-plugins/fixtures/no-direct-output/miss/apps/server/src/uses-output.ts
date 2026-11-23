// 要打印就调用统一的出口，不直接用 console：不命中。
import { printError } from "./util/output.js";

export function report(error: unknown) {
	printError("failed", error);
}
