import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * SDK 运行时 wheel（#1 评审：Agent 只依赖 uv）。控制面构建时（`pnpm --filter @sfly/server build`）
 * 把 sdk/python 打成 wheel 放进 `dist/sdk/`（或 `SFLY_SDK_DIR` 指定的目录）；启动时扫描一次。
 * Agent 握手时控制面在 Welcome 里给出与 Hello.agent_version 相同版本的下载地址和 sha256，
 * Agent 共享 venv 里的 SDK 版本不一致时下载安装。
 */
export interface SdkWheel {
	version: string;
	/** wheel 文件名（`sfly-<版本>-py3-none-any.whl`），Agent 按它识别 wheel。 */
	filename: string;
	sha256: string;
	/** 绝对路径。 */
	file: string;
}

const WHEEL = /^sfly-([0-9][^-]*)-py3-none-any\.whl$/;

/** 目录里的 SDK 运行时 wheel；目录不存在时为空。 */
export async function loadSdkWheels(dir: string | undefined): Promise<SdkWheel[]> {
	if (!dir) return [];
	const names = await readdir(dir).catch(() => [] as string[]);
	const wheels: SdkWheel[] = [];
	for (const filename of names.sort()) {
		const version = WHEEL.exec(filename)?.[1];
		if (!version) continue;
		const file = join(dir, filename);
		const sha256 = createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
		wheels.push({ version, filename, sha256, file });
	}
	return wheels;
}

/** SDK wheel 的下载地址（对 Agent 可见）。 */
export const sdkWheelUrl = (publicHttpUrl: string, wheel: SdkWheel) =>
	`${publicHttpUrl}/sdk/python/${encodeURIComponent(wheel.version)}/${encodeURIComponent(wheel.filename)}`;
