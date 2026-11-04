// 控制面入口。配置全部来自环境变量：
//   DATABASE_URL     PostgreSQL 连接串（默认 postgres://sfly:sfly@127.0.0.1:5432/sfly）
//   SFLY_DATA_DIR    数据目录：节点包文件等（默认 ./data）
//   SFLY_HTTP_HOST   HTTP API 监听地址（默认 0.0.0.0）
//   SFLY_HTTP_PORT   HTTP API 端口（默认 8080）
//   SFLY_GRPC_HOST   Agent 网关监听地址（默认 0.0.0.0）
//   SFLY_GRPC_PORT   Agent 网关端口（默认 50051）
import { startControlPlane } from "./control-plane.js";

const env = process.env;
const controlPlane = await startControlPlane({
	databaseUrl: env.DATABASE_URL ?? "postgres://sfly:sfly@127.0.0.1:5432/sfly",
	dataDir: env.SFLY_DATA_DIR ?? "./data",
	http: { host: env.SFLY_HTTP_HOST ?? "0.0.0.0", port: Number(env.SFLY_HTTP_PORT ?? 8080) },
	grpc: { host: env.SFLY_GRPC_HOST ?? "0.0.0.0", port: Number(env.SFLY_GRPC_PORT ?? 50051) },
	logger: true,
});
console.log(`sfly control plane: http ${controlPlane.httpUrl}, grpc ${controlPlane.grpcUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void controlPlane.close().then(() => process.exit(0));
	});
}
