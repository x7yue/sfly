import { ASSISTANT_SECRET_ENV, ASSISTANT_SECRET_MIN_LENGTH } from "@sfly/schema";

/**
 * 助手服务的配置：只读环境变量（#540「包和配置」）。端口、每一轮的上限、同时活着的 pi 进程数都是常量，不做配置。
 */
export interface AssistantConfig {
	/** 和控制面共用的密钥（`SFLY_ASSISTANT_SECRET`）：每个请求按常量时间比较。 */
	secret: string;
	/** pi 格式的模型文件（`SFLY_ASSISTANT_MODELS`）。 */
	modelsFile: string;
	/** 用文件里的哪个模型（`SFLY_ASSISTANT_MODEL`），照 pi 的 `--model` 写：`<提供方>/<模型>`，可以带 `:<思考强度>`。 */
	model: string | undefined;
	/** 数据目录（`SFLY_ASSISTANT_DATA`）：每个会话一个目录，pi 的设置目录也在这里。 */
	dataDir: string;
}

export const ASSISTANT_PORT = 8090;

export class ConfigError extends Error {}

/** 从环境变量读配置；共享密钥缺了或太短时抛 {@link ConfigError}（助手服务拒绝启动）。 */
export function readConfig(env: NodeJS.ProcessEnv): AssistantConfig {
	const secret = env[ASSISTANT_SECRET_ENV] ?? "";
	if (secret.length < ASSISTANT_SECRET_MIN_LENGTH) {
		throw new ConfigError(
			`${ASSISTANT_SECRET_ENV} 至少要 ${ASSISTANT_SECRET_MIN_LENGTH} 个字符（现在 ${secret.length} 个）：` +
				"工作台上的模型在网络上可能连得到助手服务，没有足够长的共享密钥谁都能让它开始一轮",
		);
	}
	return {
		secret,
		modelsFile: env.SFLY_ASSISTANT_MODELS || "/config/models.json",
		model: env.SFLY_ASSISTANT_MODEL || undefined,
		dataDir: env.SFLY_ASSISTANT_DATA || "/data",
	};
}
