import { z } from "zod";
import { download, endpoint } from "./contract.js";

/**
 * API 客户端安装包的契约（ADR 0022；约定见 ./contract.ts）。控制面带着与自己同版本的 `@sfly/client`
 * tarball，用户用包管理器直接装它的下载地址，和 SDK wheel（system.ts 的 `sdkApi`）的做法一致。
 */

/** 一个可下载的 API 客户端安装包（npm tarball）。 */
export const ClientTarballView = z.object({
	version: z.string(),
	filename: z.string(),
	sha256: z.string(),
	/** 完整的下载地址，包管理器可以直接安装它。 */
	url: z.string(),
});

export const clientPackageApi = {
	/** 控制面提供的 API 客户端安装包；没有配置目录或目录不存在时为空。 */
	list: endpoint({
		method: "GET",
		path: "/client",
		client: false,
		key: ["client-package", "list"],
		response: z.object({ tarballs: z.array(ClientTarballView) }),
	}),
	/** 下载一个安装包；版本或文件名不存在时 404。 */
	download: download({
		path: "/client/:version/:filename",
		client: false,
		params: z.object({ version: z.string(), filename: z.string() }),
		contentType: "application/octet-stream",
	}),
};

export type ClientTarballView = z.infer<typeof ClientTarballView>;
