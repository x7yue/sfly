import type { AddressInfo } from "node:net";
import { type Clock, systemClock } from "./clock.js";
import { openDatabase } from "./db/database.js";
import { startAgentGateway } from "./gateway/agent-gateway.js";
import { buildHttpApi } from "./http/api.js";

export interface ListenOptions {
	host?: string;
	/** 0 表示随机端口。 */
	port?: number;
}

export interface ControlPlaneOptions {
	databaseUrl: string;
	clock?: Clock;
	http?: ListenOptions;
	grpc?: ListenOptions;
	logger?: boolean;
}

export interface ControlPlane {
	readonly httpUrl: string;
	readonly grpcUrl: string;
	close(): Promise<void>;
}

/** 启动控制面：执行迁移，然后启动 HTTP API 和 Agent 网关。 */
export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
	const clock = options.clock ?? systemClock;
	const logger = options.logger ?? false;
	const database = openDatabase(options.databaseUrl, (error) => {
		if (logger) console.error("postgres pool error:", error.message);
	});

	try {
		await database.migrate();
	} catch (error) {
		await database.close();
		throw error;
	}

	const api = buildHttpApi({ database, clock, logger });
	const httpHost = options.http?.host ?? "127.0.0.1";
	await api.listen({ host: httpHost, port: options.http?.port ?? 0 });
	const httpPort = (api.server.address() as AddressInfo).port;

	let gateway: Awaited<ReturnType<typeof startAgentGateway>>;
	try {
		gateway = await startAgentGateway({
			host: options.grpc?.host ?? "127.0.0.1",
			port: options.grpc?.port ?? 0,
		});
	} catch (error) {
		await api.close();
		await database.close();
		throw error;
	}

	return {
		httpUrl: `http://${httpHost.includes(":") ? `[${httpHost}]` : httpHost}:${httpPort}`,
		grpcUrl: gateway.url,
		async close() {
			await gateway.close();
			await api.close();
			await database.close();
		},
	};
}
