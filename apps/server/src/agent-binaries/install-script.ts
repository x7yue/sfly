import { readFile } from "node:fs/promises";

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
}

const NAMES: ReadonlySet<string> = new Set<keyof InstallScriptValues>([
	"SFLY_URL",
	"SFLY_GRPC_URL",
	"SFLY_VERSION",
	"SHA256_X86_64",
	"SHA256_AARCH64",
]);

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/** 读取模板；出现未知的占位符时报错。 */
export async function loadInstallScript(file: string): Promise<string> {
	const template = await readFile(file, "utf8");
	for (const [, name] of template.matchAll(PLACEHOLDER)) {
		if (!(name && NAMES.has(name))) throw new Error(`${file}: 未知的占位符 {{${name}}}`);
	}
	return template;
}

export function renderInstallScript(template: string, values: InstallScriptValues): string {
	return template.replace(PLACEHOLDER, (_, name: keyof InstallScriptValues) =>
		values[name].replace(/[\r\n]/g, "").replace(/'/g, "'\\''"),
	);
}
