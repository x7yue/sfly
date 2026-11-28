/** 出网名单容器上探测服务的地址（#498）：部署者写在控制面这一侧，按工作台的 Agent 名对应。 */
export const PROBES_ENV = "SFLY_FIREWALL_PROBES";

const NAME = /^[^\s=]+$/;
const HOST = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?$/;

/**
 * 读 `SFLY_FIREWALL_PROBES`：空格或逗号分隔的「工作台的 Agent 名=主机:端口」，例如 compose 里的 `workbench=sfly-workbench:47124`。
 * 它说的是「部署者的出网名单容器在哪」，不是「哪台 Agent 是工作台」（那个只在库里，项目管理员登记，#549）：控制面把项目外 Agent
 * 的地址只发给这里写的地址，不用 Agent 自报的地址。写错时没有一台配置（`probes` 为空），原因只写第几条，不回显原文。
 */
export function probeConfig(text: string | undefined): {
	probes: Map<string, string>;
	problem?: string;
} {
	const probes = new Map<string, string>();
	const items = (text ?? "").split(/[\s,]+/).filter((item) => item !== "");
	for (const [index, item] of items.entries()) {
		const [name = "", address = ""] = item.split("=", 2);
		const colon = address.lastIndexOf(":");
		const host = address.slice(0, colon);
		const port = address.slice(colon + 1);
		const valid =
			item.split("=").length === 2 &&
			NAME.test(name) &&
			colon > 0 &&
			HOST.test(host) &&
			/^[0-9]{1,5}$/.test(port) &&
			Number(port) >= 1 &&
			Number(port) <= 65_535;
		if (!valid) {
			return {
				probes: new Map(),
				problem: `${PROBES_ENV} 第 ${index + 1} 条要写成「工作台的 Agent 名=主机:端口」，所有工作台都按没有配置探测处理`,
			};
		}
		probes.set(name, address);
	}
	return { probes };
}
