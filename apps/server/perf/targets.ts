// 性能目标只写在 docs/ARCHITECTURE.md §7.6 的目标表里；报告里的目标原文从那里读取，避免两处不一致。
// 各项判定与负载要用的数字集中在下面，单测（test/perf-items.test.ts）用 targetQuantities 从表里读出数量逐个核对，
// 改了表而没改这里时单测失败。不在运行时从表里取数：负载的规模（速率、时长）也由这些数字决定，
// 文档里的笔误不该悄悄改变负载。表里没有的数（容差、余量）写在各项文件里并说明来历。

/** 单个任务 SDK → Agent：持续每秒 1 万次事件。 */
export const EVENTS_PER_SECOND = 10_000;
/** 单个 Agent：4 个槽位同时上报。 */
export const AGENT_SLOTS = 4;
/** 单个 Agent：内存增量 ≤ 100 MB。 */
export const AGENT_RSS_GROWTH_MB = 100;
/** 节点大量输出 stdout：每秒 10 MB（负载按 MiB 写）。 */
export const STDOUT_MIB_PER_SECOND = 10;
/** 节点大量输出 stdout：`stdout.log` 最多 16 MiB。 */
export const STDOUT_LOG_MAX_MIB = 16;
/** 控制面接收指标：持续每秒 1 万点。 */
export const INGEST_POINTS_PER_SECOND = 10_000;
/** 控制面接收指标：持续 1 小时，查询 1 小时范围（秒）。 */
export const INGEST_SECONDS = 3600;
/** 控制面接收指标：1 小时范围的指标查询 p95 < 500 ms。 */
export const QUERY_P95_MS = 500;
/** 端到端延迟：3 秒内收到 SSE 推送。 */
export const END_TO_END_MS = 3000;
/** Agent 断线：断线 5 分钟（秒）。 */
export const DISCONNECT_SECONDS = 300;
/** 短节点链路：30 个节点的单链。 */
export const CHAIN_NODES = 30;
/** 短节点链路：sfly-std 的短节点每节点端到端 ≤ 120 ms。 */
export const SHORT_NODE_MS = 120;

/** 读出 §7.6 目标表：范围 → 目标原文。 */
export function parseTargets(architecture: string): Map<string, string> {
	const targets = new Map<string, string>();
	let inSection = false;
	for (const line of architecture.split("\n")) {
		if (/^#{1,6} /.test(line)) {
			inSection = /^### 7\.6 /.test(line);
			continue;
		}
		if (!inSection || !line.startsWith("|")) continue;
		const cells = line
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim());
		const [scope, target] = cells;
		if (cells.length !== 2 || !scope || !target) continue;
		if (scope === "范围" || /^-+$/.test(scope)) continue;
		targets.set(scope, target);
	}
	return targets;
}

const QUANTITY = /(?<![\w.])(\d+(?:\.\d+)?)\s*(万)?\s*(次|点|个|MiB|MB|ms|秒|分钟|小时)/g;

/** 目标原文里带单位的数量，按出现顺序：「1 万」乘一万，分钟、小时换算成秒。 */
export function targetQuantities(text: string): Array<{ value: number; unit: string }> {
	return [...text.matchAll(QUANTITY)].map(([, number, wan, unit]) => {
		const value = Number(number) * (wan ? 10_000 : 1);
		if (unit === "分钟") return { value: value * 60, unit: "秒" };
		if (unit === "小时") return { value: value * 3600, unit: "秒" };
		return { value, unit: unit as string };
	});
}
