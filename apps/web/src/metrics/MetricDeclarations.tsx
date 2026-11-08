import { type ChartView, isLabeled, type MetricDeclaration, type NodeTypeView } from "@sfly/schema";
import { Badge } from "@/components/ui/badge";

/**
 * 节点类型声明的指标与图表（#43）：节点包管理页的「声明的指标」「标签键」「图表」三列，检查器的「说明与指标」。
 * 图表含控制面为没被任何图表引用的指标生成的默认图表（`default: true`），随锁定的节点包版本走。
 */

/** 节点类型里与指标有关的部分；早于指标功能的节点包没有这些字段。 */
export type NodeMetricsInfo = Partial<Pick<NodeTypeView, "metrics" | "charts" | "primary_metric">>;

const KIND_LABEL: Record<MetricDeclaration["kind"], string> = {
	gauge: "瞬时值",
	counter: "累计值",
};

const CHART_LABEL: Record<ChartView["type"], string> = {
	line: "折线",
	area: "面积",
	bar: "柱状",
	stat: "数值卡",
};

const metricTitle = (m: MetricDeclaration) =>
	`${m.name}（${KIND_LABEL[m.kind]}）${m.description ? `：${m.description}` : ""}`;

const metricsOf = (info: NodeMetricsInfo) => (Array.isArray(info.metrics) ? info.metrics : []);
const chartsOf = (info: NodeMetricsInfo) => (Array.isArray(info.charts) ? info.charts : []);

/** 节点包管理页「声明的指标」列：指标名与单位，悬停看种类与说明。 */
export function MetricsCell({ info }: { info: NodeMetricsInfo }) {
	const metrics = metricsOf(info);
	if (metrics.length === 0) return <span className="text-fg-3">—</span>;
	return (
		<span className="font-mono text-xs text-fg-2">
			{metrics.map((m, i) => (
				<span key={m.name}>
					{i > 0 && " · "}
					<span title={metricTitle(m)}>
						{m.name}
						{m.unit && <span className="text-fg-3"> {m.unit}</span>}
					</span>
				</span>
			))}
		</span>
	);
}

/** 节点包管理页「标签键」列：每个带标签的指标一行，列出它的标签键（按声明顺序）。 */
export function LabelKeysCell({ info }: { info: NodeMetricsInfo }) {
	const labeled = metricsOf(info).filter(isLabeled);
	if (labeled.length === 0) return <span className="text-fg-3">—</span>;
	return (
		<ul aria-label="标签键" className="m-0 list-none p-0 font-mono text-xs text-fg-2">
			{labeled.map((m) => (
				<li key={m.name}>
					{m.name}
					<span className="text-fg-3">：</span>
					{m.labels?.join(" · ")}
				</li>
			))}
		</ul>
	);
}

/** 节点包管理页「图表」列：图表数与主指标，下一行是各图表标题（默认生成的标出「默认」）。 */
export function ChartsCell({ info }: { info: NodeMetricsInfo }) {
	const charts = chartsOf(info);
	if (charts.length === 0) return <span className="text-xs text-fg-3">—（平台自带图表）</span>;
	return (
		<div className="text-xs">
			<div className="text-fg-2">
				{charts.length} 张
				{info.primary_metric && (
					<>
						{" · 主指标 "}
						<span className="font-mono">{info.primary_metric}</span>
					</>
				)}
			</div>
			<div className="text-fg-3">
				{charts.map((c, i) => (
					<span key={c.title} title={`${CHART_LABEL[c.type]}：${c.metrics.join("、")}`}>
						{i > 0 && " · "}
						{c.title}
						{c.default && " 默认"}
					</span>
				))}
			</div>
		</div>
	);
}

/** 检查器「说明与指标」里的「声明的指标与图表」；info 为 undefined 表示还在加载，null 表示找不到节点类型。 */
export function MetricDeclarations({ info }: { info: NodeMetricsInfo | null | undefined }) {
	if (info === undefined) {
		return <p className="m-0 text-xs text-fg-3">正在加载节点类型的元信息…</p>;
	}
	if (info === null) {
		return <p className="m-0 text-xs text-fg-3">找不到这个节点类型，无法显示它声明的指标。</p>;
	}
	const metrics = metricsOf(info);
	const charts = chartsOf(info);
	if (metrics.length === 0 && charts.length === 0) {
		return (
			<p className="m-0 text-xs text-fg-3">这个节点类型没有声明指标，运行时只显示平台自带图表。</p>
		);
	}
	return (
		<>
			<ul aria-label="声明的指标" className="m-0 flex list-none flex-col gap-1.5 p-0">
				{metrics.map((m) => (
					<li key={m.name} className="text-xs">
						<div className="flex items-center gap-1.5">
							<span className="font-mono text-sm">{m.name}</span>
							{m.unit && <span className="text-fg-3">{m.unit}</span>}
							<span className="text-fg-3">· {KIND_LABEL[m.kind]}</span>
							{m.name === info.primary_metric && <Badge className="ml-auto">主指标</Badge>}
						</div>
						{m.description && <div className="text-fg-3">{m.description}</div>}
					</li>
				))}
			</ul>
			<h4 className="mt-3 mb-1.5 text-2xs font-semibold text-fg-2">图表 {charts.length} 张</h4>
			<ul aria-label="图表" className="m-0 flex list-none flex-col gap-1 p-0">
				{charts.map((c) => (
					<li key={c.title} className="flex items-center gap-1.5 text-xs">
						<span className="min-w-0 truncate">{c.title}</span>
						<span className="flex-none text-fg-3">{CHART_LABEL[c.type]}</span>
						<span className="min-w-0 truncate font-mono text-fg-3">{c.metrics.join(" · ")}</span>
						{c.default && (
							<Badge className="ml-auto" title="没被任何图表引用的指标，由平台生成默认图表">
								默认
							</Badge>
						)}
					</li>
				))}
			</ul>
			<p className="m-0 mt-2.5 text-2xs text-fg-3">
				图表定义来自节点包元信息，随锁定的版本走；场景里不需要配置。
			</p>
		</>
	);
}
