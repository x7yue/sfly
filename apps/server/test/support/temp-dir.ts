// 测试里建临时目录只走这里（biome-plugins/test-temp-dir.grit）：返回真实路径，见 CODING_STANDARDS.md「测试」。
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 在系统临时目录下新建一个目录，返回它的真实路径（macOS 的 `/tmp`、`/var` 是符号链接）。 */
export async function makeTempDir(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** 同 makeTempDir，同步版。 */
export function makeTempDirSync(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
