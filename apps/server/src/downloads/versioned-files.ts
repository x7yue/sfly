import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 控制面随构建带着、按版本提供下载的文件（SDK wheel、API 客户端安装包）。 */
export interface VersionedFile {
	version: string;
	filename: string;
	sha256: string;
	/** 绝对路径。 */
	file: string;
}

/**
 * 目录里文件名匹配 `pattern` 的文件（第一个捕获组是版本号），启动时扫描一次并算好 sha256；
 * 没有配置目录或目录不存在时为空，控制面照常启动。
 */
export async function loadVersionedFiles(
	dir: string | undefined,
	pattern: RegExp,
): Promise<VersionedFile[]> {
	if (!dir) return [];
	const names = await readdir(dir).catch(() => [] as string[]);
	const files: VersionedFile[] = [];
	for (const filename of names.sort()) {
		const version = pattern.exec(filename)?.[1];
		if (!version) continue;
		const file = join(dir, filename);
		const sha256 = createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
		files.push({ version, filename, sha256, file });
	}
	return files;
}
