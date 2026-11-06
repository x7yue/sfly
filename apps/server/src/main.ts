// 控制面入口。配置全部来自环境变量：
//   DATABASE_URL     PostgreSQL 连接串（默认 postgres://sfly:sfly@127.0.0.1:5432/sfly）
//   SFLY_DATA_DIR    数据目录：节点包文件等（默认 ./data）
//   SFLY_HTTP_HOST   HTTP API 监听地址（默认 0.0.0.0）
//   SFLY_HTTP_PORT   HTTP API 端口（默认 8080）
//   SFLY_GRPC_HOST   Agent 网关监听地址（默认 0.0.0.0）
//   SFLY_GRPC_PORT   Agent 网关端口（默认 50051）
//   SFLY_AGENT_TOKEN Agent 共享注册令牌（可选；设置后令牌不对的 Agent 被拒绝）
//   SFLY_PUBLIC_URL  HTTP API 对 Agent 可见的地址，Agent 从这里下载节点包
//                    （可选；默认取监听地址，监听 0.0.0.0 时用本机主机名）
//   SFLY_RETENTION_DAYS   日志和产物的保留天数（默认 30），运行结束超过这么久后自动清理
//   SFLY_METRIC_RETENTION_DAYS 指标的保留天数（默认 30），整天超过保留期的指标分区自动删除
//   SFLY_LOG_LIMIT_MB     单个任务日志的上限（默认 200），超出部分截断
//   SFLY_ARTIFACT_LIMIT_MB 单个任务产物的总大小上限（默认 1024）
//   SFLY_METRIC_LIMIT_MB  单个任务指标数据的上限（默认 50，按点数折算），超出后停止写入
//   SFLY_SDK_DIR     SDK 运行时 wheel 所在目录（默认 apps/server/dist/sdk，由 `pnpm --filter @sfly/server build` 生成）；
//                    Agent 从控制面下载与自身版本一致的 SDK 装进共享 venv
//   SFLY_WEB_DIR     前端构建产物目录（默认 apps/web/dist，由 `pnpm --filter @sfly/web build` 生成）；
//                    控制面在 HTTP 端口上同时提供页面（ADR 0006）。未设置且默认目录不存在时只提供 API
//   SFLY_MIGRATIONS_DIR 数据库迁移目录（默认 apps/server/drizzle）
//   SFLY_DOCS_DIR    用户文档目录（默认仓库的 docs/guide，ADR 0013），控制面提供 /docs/<页>.md 与 /llms.txt
// 打包成单文件后（scripts/bundle.ts，ADR 0010），上面四个目录的默认值改为 main.mjs 旁边的
// sdk/、web/、drizzle/、docs/。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { startControlPlane } from "./control-plane.js";
import { defaultMigrationsDir } from "./db/database.js";

/** 打包成单文件时由 esbuild 定义为 true（scripts/bundle.ts）；源码运行时未定义。 */
declare const SFLY_BUNDLED: boolean | undefined;
const bundled = typeof SFLY_BUNDLED !== "undefined" && SFLY_BUNDLED;
const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const defaults = bundled
	? {
			webDir: fromHere("./web"),
			sdkDir: fromHere("./sdk"),
			migrationsDir: fromHere("./drizzle"),
			docsDir: fromHere("./docs"),
		}
	: {
			webDir: fromHere("../../web/dist"),
			sdkDir: fromHere("../dist/sdk"),
			migrationsDir: defaultMigrationsDir,
			docsDir: fromHere("../../../docs/guide"),
		};

const env = process.env;
const MB = 1024 * 1024;
/** 可选的正数环境变量；未设置时为 undefined（用默认值），非法值直接报错退出。 */
const positive = (name: string): number | undefined => {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!(n > 0)) throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
	return n;
};
const mb = (name: string) => {
	const n = positive(name);
	return n === undefined ? undefined : Math.floor(n * MB);
};
const webDir = env.SFLY_WEB_DIR || (existsSync(defaults.webDir) ? defaults.webDir : undefined);
if (!webDir) console.warn(`sfly: ${defaults.webDir} not found, serving the API only (no web app)`);
const controlPlane = await startControlPlane({
	databaseUrl: env.DATABASE_URL ?? "postgres://sfly:sfly@127.0.0.1:5432/sfly",
	dataDir: env.SFLY_DATA_DIR ?? "./data",
	http: { host: env.SFLY_HTTP_HOST ?? "0.0.0.0", port: Number(env.SFLY_HTTP_PORT ?? 8080) },
	grpc: { host: env.SFLY_GRPC_HOST ?? "0.0.0.0", port: Number(env.SFLY_GRPC_PORT ?? 50051) },
	logger: true,
	agentToken: env.SFLY_AGENT_TOKEN || undefined,
	publicHttpUrl: env.SFLY_PUBLIC_URL || undefined,
	retentionDays: positive("SFLY_RETENTION_DAYS"),
	metricRetentionDays: positive("SFLY_METRIC_RETENTION_DAYS"),
	logLimitBytes: mb("SFLY_LOG_LIMIT_MB"),
	artifactLimitBytes: mb("SFLY_ARTIFACT_LIMIT_MB"),
	metricLimitBytes: mb("SFLY_METRIC_LIMIT_MB"),
	sdkWheelDir: env.SFLY_SDK_DIR || defaults.sdkDir,
	webDir,
	docsDir: env.SFLY_DOCS_DIR || defaults.docsDir,
	migrationsDir: env.SFLY_MIGRATIONS_DIR || defaults.migrationsDir,
});
console.log(
	`sfly control plane ${packageJson.version}: http ${controlPlane.httpUrl}, grpc ${controlPlane.grpcUrl}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void controlPlane.close().then(() => process.exit(0));
	});
}
