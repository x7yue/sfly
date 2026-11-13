import { loadVersionedFiles, type VersionedFile } from "./versioned-files.js";

/**
 * API 客户端安装包（ADR 0022）：构建时（`pnpm --filter @sfly/server build`）把 packages/client 打成 tarball
 * 放进 `dist/client/`（或 `SFLY_CLIENT_DIR` 指定的目录），控制面启动时扫描一次，用户用包管理器直接装它的下载地址。
 */
export type ClientTarball = VersionedFile;

const TARBALL = /^sfly-client-([0-9][^-]*)\.tgz$/;

/** 目录里的 API 客户端安装包；目录不存在时为空。 */
export const loadClientTarballs = (dir: string | undefined) => loadVersionedFiles(dir, TARBALL);

/** API 客户端安装包的下载地址。 */
export const clientTarballUrl = (publicHttpUrl: string, tarball: ClientTarball) =>
	`${publicHttpUrl}/client/${encodeURIComponent(tarball.version)}/${encodeURIComponent(tarball.filename)}`;
