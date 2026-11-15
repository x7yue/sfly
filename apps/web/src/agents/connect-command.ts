import { agentBinariesApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { apiQuery } from "#/lib/api";

/**
 * 接入命令：在测试机上运行控制面的 install.sh（ADR 0011）。地址用控制面给出的对外地址（SFLY_PUBLIC_URL），
 * 还没取到时用浏览器当前访问的地址。Agent 管理页和控制台的「开始使用」共用。
 */
export function useConnectCommand() {
	const binaries = useQuery(apiQuery(agentBinariesApi.list));
	const url = binaries.data?.install_script_url ?? `${window.location.origin}/install.sh`;
	return `curl -fsSL ${url} | sh -s -- --name <名称>`;
}
