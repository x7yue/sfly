import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import type { Clock } from "../../src/clock.js";
import {
	type ControlPlane,
	type ControlPlaneOptions,
	startControlPlane,
} from "../../src/control-plane.js";
import { ManualClock } from "./manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";

export interface TestControlPlane {
	/** 当前实例；restart() 之后会换成新实例。 */
	readonly current: ControlPlane;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	readonly clock: Clock;
	readonly database: TestDatabase;
	/** 临时数据目录；restart() 后保留，close() 时删除。 */
	readonly dataDir: string;
	/** 对 HTTP API 发请求，path 以 / 开头。 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/**
	 * 停掉当前实例，在同一个数据库、同样的 HTTP / gRPC 端口上重新启动（模拟控制面重启；
	 * 端口不变，真实 Agent 才能按原地址重连、继续下载和上传）；
	 * `whileDown` 在停机期间执行（例如推进手动时钟模拟停机时长）。
	 */
	restart(whileDown?: () => void | Promise<void>): Promise<void>;
	/** 停掉实例并删除临时数据库。 */
	close(): Promise<void>;
}

const portOf = (url: string) => Number(new URL(url).port);

/**
 * 在独立的临时数据库和临时数据目录上启动一个真实的控制面，HTTP 与 gRPC 都监听随机端口。
 * 默认注入 ManualClock，可以传入自己的时钟；agentToken 为共享注册令牌（默认不校验）。
 * 日志上限、产物上限、保留期等（#18）可以按需覆盖。
 */
export async function startTestControlPlane(
	options: { clock?: Clock; agentToken?: string } & Pick<
		ControlPlaneOptions,
		| "logLimitBytes"
		| "metricLimitBytes"
		| "artifactLimitBytes"
		| "retentionDays"
		| "metricRetentionDays"
		| "leaseMs"
		| "sdkWheelDir"
		| "webDir"
	> = {},
): Promise<TestControlPlane> {
	const clock = options.clock ?? new ManualClock();
	const database = await createTestDatabase();
	const dataDir = await mkdtemp(join(tmpdir(), "sfly-test-"));
	const start = (ports = { http: 0, grpc: 0 }) =>
		startControlPlane({
			databaseUrl: database.url,
			dataDir,
			clock,
			agentToken: options.agentToken,
			logLimitBytes: options.logLimitBytes,
			metricLimitBytes: options.metricLimitBytes,
			// 指标写入扫描（#29）同样调快。
			metricFlushIntervalMs: 20,
			artifactLimitBytes: options.artifactLimitBytes,
			retentionDays: options.retentionDays,
			metricRetentionDays: options.metricRetentionDays,
			leaseMs: options.leaseMs,
			sdkWheelDir: options.sdkWheelDir,
			webDir: options.webDir,
			// 保留期清理也调快（只按注入的时钟判断是否到期）。
			retentionSweepIntervalMs: 20,
			// 定时 / Sleep 节点的定时器扫描（#14）同样调快。
			timerSweepIntervalMs: 20,
			// 周期扫描调快：测试推进手动时钟后很快就能观察到效果，不用真实等待。
			sweepIntervalMs: 20,
			http: { host: "127.0.0.1", port: ports.http },
			grpc: { host: "127.0.0.1", port: ports.grpc },
		});

	let current: ControlPlane;
	try {
		current = await start();
	} catch (error) {
		await database.drop();
		await rm(dataDir, { recursive: true, force: true });
		throw error;
	}

	// 每个控制面实例一套独立的 HTTP 连接池：重启时销毁旧池，重启后的请求不会复用
	// 已被旧实例关闭的 keep-alive 连接（全局 fetch 的连接池会复用，偶发 ECONNRESET）。
	let dispatcher = new Agent();

	return {
		get current() {
			return current;
		},
		get httpUrl() {
			return current.httpUrl;
		},
		get grpcUrl() {
			return current.grpcUrl;
		},
		clock,
		database,
		dataDir,
		fetch: (path, init) =>
			fetch(`${current.httpUrl}${path}`, { ...init, dispatcher } as RequestInit),
		async restart(whileDown) {
			const ports = { http: portOf(current.httpUrl), grpc: portOf(current.grpcUrl) };
			await current.close();
			const old = dispatcher;
			dispatcher = new Agent();
			await old.destroy();
			await whileDown?.();
			current = await start(ports);
		},
		async close() {
			await current.close();
			await dispatcher.destroy();
			await database.drop();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}
