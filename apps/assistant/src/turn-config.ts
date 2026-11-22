import { readFileSync } from "node:fs";

/**
 * 助手服务交给远程工具扩展的这一轮的配置（#540「远程工具扩展」）：工作台的地址、命令要加的环境变量、默认超时
 * 每一轮可能不同，而 pi 进程跨轮存活，所以助手服务每一轮开始时写一个只有属主可读的文件，扩展在每次执行命令时读它，
 * 这一轮结束时删掉。命令的环境变量（含保密的会话令牌）只出现在这个文件和发给 Agent 的执行请求里，不进 pi 的环境。
 */
export interface TurnConfig {
	/** 工作台 Agent 的能力端口：`主机:端口`。 */
	address: string;
	/** 工作区在工作台上的路径：工具在这里解析相对路径，系统提示里写的工作目录也是它。 */
	workdir: string;
	/** 命令要加的环境变量（普通的和保密的合在一起）。 */
	env: Record<string, string>;
	/** 模型没给超时的命令用多少秒（能力端口要求命令必须有超时）。 */
	defaultTimeoutSeconds: number;
	/** 镜像里的 skill 目录（`--skill` 给 pi 的）和它在工作台上的位置：系统提示里 skill 的位置写成工作台上的。 */
	skills: { local: string; workbench: string };
}

export function readTurnConfig(path: string): TurnConfig {
	return JSON.parse(readFileSync(path, "utf8")) as TurnConfig;
}
