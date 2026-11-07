// 负载：控制面持续每秒接收 1 万个指标点（ARCHITECTURE §7.6「控制面接收指标」）。负载、断言与记录的数值见
// perf/control-plane-load.ts；这一项只启动独立的数据库与打包后的控制面（假 Agent 代替真实 Agent）。
// 持续时间默认 60 秒，可以用环境变量 SFLY_PERF_CONTROL_PLANE_SECONDS 改；长时负载测试（pnpm perf:soak）跑满时长。
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { startBundledServer } from "../../test/support/bundled-server.js";
import { createTestDatabase } from "../../test/support/test-database.js";
import { controlPlaneLoad } from "../control-plane-load.js";
import { definePerfItem, type ItemRun, type PerfContext } from "../item.js";
import { durationSeconds } from "../metric-load.js";
import { PerfApi } from "../stack.js";

/** 持续时间的环境变量（秒）。 */
export const SECONDS_ENV = "SFLY_PERF_CONTROL_PLANE_SECONDS";
const DEFAULT_SECONDS = 60;

/** 控制面接收指标负载；seconds 不传时读环境变量 {@link SECONDS_ENV}（默认 60 秒）。 */
export function controlPlaneMetrics(seconds?: number) {
	return definePerfItem({
		id: "control-plane-metrics",
		title: "控制面每秒接收 1 万个指标点",
		scope: "控制面接收指标",
		needsArtifacts: true,
		run: (ctx) => run(ctx, seconds ?? durationSeconds(process.env, SECONDS_ENV, DEFAULT_SECONDS)),
	});
}

async function run(ctx: PerfContext, seconds: number): Promise<ItemRun> {
	ctx.log("启动被测对象：数据库与打包后的控制面（假 Agent 代替真实 Agent）");
	const database = await createTestDatabase("sfly_perf");
	ctx.defer(() => database.drop());
	const server = await startBundledServer({
		dir: ctx.artifacts.bundleDir,
		databaseUrl: database.url,
		dataDir: await mkdtemp(join(ctx.tmpDir, "data-")),
	});
	ctx.defer(() => server.stop());
	return controlPlaneLoad(
		ctx,
		{
			api: new PerfApi(server.httpUrl),
			grpcUrl: server.grpcUrl,
			databaseUrl: database.url,
			serverPid: server.child.pid as number,
		},
		seconds,
	);
}

export default controlPlaneMetrics();
