import { loadVersionedFiles, type VersionedFile } from "../downloads/versioned-files.js";

/**
 * SDK 运行时 wheel（#1 评审：Agent 只依赖 uv）。控制面构建时（`pnpm --filter @sfly/server build`）
 * 把 sdk/python 打成 wheel 放进 `dist/sdk/`（或 `SFLY_SDK_DIR` 指定的目录）；启动时扫描一次。
 * Agent 握手时控制面在 Welcome 里给出与 Hello.agent_version 相同版本的下载地址和 sha256，
 * Agent 共享 venv 里的 SDK 版本不一致时下载安装。
 */
export type SdkWheel = VersionedFile;

const WHEEL = /^sfly-([0-9][^-]*)-py3-none-any\.whl$/;

/** 目录里的 SDK 运行时 wheel；目录不存在时为空。 */
export const loadSdkWheels = (dir: string | undefined) => loadVersionedFiles(dir, WHEEL);

/** SDK wheel 的下载地址（对 Agent 可见）。 */
export const sdkWheelUrl = (publicHttpUrl: string, wheel: SdkWheel) =>
	`${publicHttpUrl}/sdk/python/${encodeURIComponent(wheel.version)}/${encodeURIComponent(wheel.filename)}`;
