import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 规则只管 apps/server/test/：产品代码里同样的写法不拦。
export async function scratch() {
	return mkdtemp(join(tmpdir(), "sfly-scratch-"));
}
