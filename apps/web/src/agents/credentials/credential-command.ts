import { AGENT_NAME_MAX_LENGTH, unsafeNameProblem } from "@sfly/schema";

/**
 * 装到测试机上的命令（签发凭据之后的弹窗、「接入 Agent」弹窗、空状态、开始使用共用）：
 *
 *   read -rs SFLY_TOKEN && export SFLY_TOKEN
 *   curl -fsSL <地址>/install.sh | sh -s -- --name <名称>
 *
 * **凭据原值不在命令里**：第一行 `read -rs` 在运行时读入（粘贴后回车，输入不显示），经环境变量 `SFLY_TOKEN` 交给安装脚本，
 * 所以原值不会进命令行参数（进程列表看得到）和 shell 历史（`install-agent.md` 的「用环境变量传凭据」）。这样命令本身可以放心
 * 显示和复制，原值只在签发那一次的弹窗里出现。
 */
export const READ_TOKEN_LINE = "read -rs SFLY_TOKEN && export SFLY_TOKEN";

/** 不用加引号就能原样交给 shell 的字符（字母、数字和 `_@%+=:,./-`）。 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * 写进命令里的一个参数：只有安全字符时原样，否则整个放进单引号（里面的单引号写成 `'\''`）。
 * Agent 的名称是别人起的（Hello 里报的，早期没有字符检查），复制进终端之前必须保证它只是一个参数：
 * 名称里的 `$(…)`、反引号、`;`、空格、引号都不会被 shell 当成命令。
 */
export const shellQuote = (value: string): string =>
	SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * 装到一台 Agent 上的命令；`name` 是签发凭据时的名字（`--name` 要和它一致，不一致控制面拒绝连接），
 * 还不知道名字时（「接入 Agent」弹窗、空状态）是占位 `<名称>`。
 */
export function installCommand(installUrl: string, name: string | null): string {
	const target = name === null ? "<名称>" : shellQuote(name);
	return `${READ_TOKEN_LINE}\ncurl -fsSL ${shellQuote(installUrl)} | sh -s -- --name ${target}`;
}

/**
 * 给还没连过的名字签发凭据时，输入的名称有什么问题（没有问题是 undefined）。和控制面签发那一步是同一个规则
 * （`agentsApi.issueCredential` 的路径参数）：不能有控制字符、双向文字的控制字符和零宽空格这类看不见的字符，
 * 最多 {@link AGENT_NAME_MAX_LENGTH} 个字符（按字符数，不是字节）。不合格的说明带第几个字符、哪个码位。
 * 名称不做 `trim`：Agent 的 `--name` 要和签发时一字不差。
 */
export function agentNameProblem(name: string): string | undefined {
	if (name === "") return "填写 Agent 的名称";
	const unsafe = unsafeNameProblem("Agent 的名称", name);
	if (unsafe !== undefined) return unsafe;
	if ([...name].length > AGENT_NAME_MAX_LENGTH) {
		return `Agent 的名称不能超过 ${AGENT_NAME_MAX_LENGTH} 个字符`;
	}
	return undefined;
}
