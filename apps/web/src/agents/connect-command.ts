import { agentBinariesApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { installCommand } from "#/agents/credentials/credential-command";
import { apiQuery } from "#/lib/api";

/**
 * 控制面的 install.sh 地址（ADR 0011）：用控制面给出的对外地址（SFLY_PUBLIC_URL），还没取到时用浏览器当前访问的地址。
 */
export function useInstallUrl(): string {
	const binaries = useQuery(apiQuery(agentBinariesApi.list));
	return binaries.data?.install_script_url ?? `${window.location.origin}/install.sh`;
}

/**
 * 接入命令：在测试机上运行控制面的 install.sh。每台 Agent 用自己的凭据连接（ADR 0029）：凭据先在 Agent 管理页按台签发，
 * 经环境变量 `SFLY_TOKEN` 传给安装命令（`read -rs` 读入，不进命令行参数）。名字写占位 `<名称>`：签发凭据之后的弹窗里是写好名字的命令。
 * Agent 管理页的接入弹窗、空状态和控制台的「开始使用」共用。
 */
export function useConnectCommand() {
	return installCommand(useInstallUrl(), null);
}
