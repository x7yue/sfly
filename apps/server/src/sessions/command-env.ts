import type { Actor } from "../actor.js";

/** 会话令牌放进哪个环境变量：工作台上 `sfly` 命令行读它，带上 `Authorization: Bearer <它>`（`sdk/python/src/sfly/cli/client.py`）。 */
export const SESSION_TOKEN_ENV = "SFLY_API_TOKEN";

/**
 * 一轮在工作台上执行命令时要加的环境变量（协议里 `PromptCommandBody` 的 `env` 和 `secret_env`）。**只在这一个函数里生成**，
 * 每一轮可以不同：`env` 是 `SFLY_NICKNAME`（发起这句话的人的显示名：命令行不再拿它当身份，#494，技能拿它给联调副本起名）、`SFLY_SESSION_ID`（这个会话的 ID：会话令牌的 `sfly run … latest`
 * 按它找这个会话触发的最近一次运行，#787）和 `AI_AGENT=pi`，都是普通的；
 * `secret_env` 是这一轮的会话令牌 `SFLY_API_TOKEN`（`./session-tokens.ts` 签发的，#547）：**会话令牌的原值只在这里进入命令的环境**，
 * 随 `prompt` 命令交给助手服务，助手服务放进这一轮的扩展配置文件（0600，一轮结束就删）；它在 `secret_env` 里，也就是 secret 环境变量，
 * 不进任何事件和助手服务的日志，助手服务发出事件和写 `events.jsonl` 之前按值打码，控制面收事件时再按令牌格式打一遍。
 */
export function commandEnv(
	actor: Pick<Actor, "name">,
	sessionId: string,
	sessionToken: string,
): {
	env: Record<string, string>;
	secret_env: Record<string, string>;
} {
	return {
		env: { SFLY_NICKNAME: actor.name, SFLY_SESSION_ID: sessionId, AI_AGENT: "pi" },
		secret_env: { [SESSION_TOKEN_ENV]: sessionToken },
	};
}
