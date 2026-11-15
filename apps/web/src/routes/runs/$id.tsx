import { createFileRoute } from "@tanstack/react-router";
import { MonitorPage } from "#/monitor/MonitorPage";
import { MonitorSearch } from "#/monitor/run-link";

/**
 * 运行监控页（全屏，不带外壳）：实时或回看某次运行。地址参数 `node`、`tab`、`at` 见 run-link.ts：
 * 打开时选中节点、切到底部页签、日志定位到某一刻；`runMonitorLink` 生成这样的链接。
 */
export const Route = createFileRoute("/runs/$id")({
	validateSearch: MonitorSearch,
	component: MonitorRoute,
});

function MonitorRoute() {
	const { id } = Route.useParams();
	const address = Route.useSearch();
	return <MonitorPage key={id} runId={id} address={address} />;
}
