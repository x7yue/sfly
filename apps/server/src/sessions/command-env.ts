import type { Actor } from "../actor.js";

/**
 * 一轮在工作台上执行命令时要加的环境变量（协议里 `PromptCommandBody` 的 `env` 和 `secret_env`）。**只在这一个函数里生成**，
 * 每一轮可以不同：竖切里是 `SFLY_NICKNAME`（发起这句话的人的昵称）和 `AI_AGENT=pi`，都是普通的；
 * #547 起在 `secret_env` 里加会话令牌 `SFLY_API_TOKEN`（保密的那份不进任何事件和助手服务的日志），别处都不用改。
 */
export function commandEnv(actor: Pick<Actor, "nickname">): {
	env: Record<string, string>;
	secret_env: Record<string, string>;
} {
	return {
		env: { SFLY_NICKNAME: actor.nickname, AI_AGENT: "pi" },
		secret_env: {},
	};
}
