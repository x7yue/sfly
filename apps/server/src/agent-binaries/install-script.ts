import { readFile } from "node:fs/promises";
import { placeholders } from "../placeholders.js";

/**
 * 一键安装脚本 install.sh（ADR 0011）：模板是同目录的 install.sh（打包后在 main.mjs 旁边），
 * 用 `{{名称}}` 表示控制面返回时才知道的值（{@link InstallScriptValues}）。启动时读取一次，返回时替换。
 * 取值替换进 shell 单引号字符串，单引号按 shell 规则转义。
 */
export interface InstallScriptValues {
	/** 控制面 HTTP 地址（对测试机可见，不带末尾的 /）。 */
	SFLY_URL: string;
	/** Agent 网关（gRPC）地址。 */
	SFLY_GRPC_URL: string;
	SFLY_VERSION: string;
	/** 各架构 Agent 的 sha256；控制面没有这个架构时为空串。 */
	SHA256_X86_64: string;
	SHA256_AARCH64: string;
	/** 控制面配置的 PyPI 镜像、GitHub Release 镜像（`--dev` 安装 uv 和 sfly CLI 时用）；未配置时为空串。 */
	PYPI_MIRROR: string;
	GITHUB_RELEASE_MIRROR: string;
}

const PLACEHOLDERS = placeholders<keyof InstallScriptValues>(
	[
		"SFLY_URL",
		"SFLY_GRPC_URL",
		"SFLY_VERSION",
		"SHA256_X86_64",
		"SHA256_AARCH64",
		"PYPI_MIRROR",
		"GITHUB_RELEASE_MIRROR",
	],
	(value) => value.replace(/[\r\n]/g, "").replace(/'/g, "'\\''"),
);

/** 读取模板；出现未知的占位符时报错。 */
export async function loadInstallScript(file: string): Promise<string> {
	const template = await readFile(file, "utf8");
	PLACEHOLDERS.check(file, template);
	return template;
}

export const renderInstallScript = (template: string, values: InstallScriptValues): string =>
	PLACEHOLDERS.render(template, values);
