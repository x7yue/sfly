import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Section } from "#/canvas/Inspector";
import { KIND_LABEL, KindChip } from "#/canvas/NodeCard";
import { getOrchestration } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import { getVersion } from "#/versions/api";
import {
	type AttemptView,
	type ChainRunView,
	getRun,
	type NodeRunView,
	type ParamDecl,
	type RunView,
	runEventsPath,
} from "./api";
import { CancelRunButton } from "./cancel";
import { chainOfNode, instancesByChain, nodeStates, pickedInstance } from "./chains";
import { ErrorKindTag, FailureSummary } from "./failure";
import {
	durationBetween,
	formatTime,
	runStatusLabel,
	shortId,
	statusLabel,
	statusTone,
} from "./format";
import { applyProgress, type ProgressEvent } from "./logs";
import { RunCanvas, usePackageTitles } from "./RunCanvas";
import { TaskTelemetry } from "./TaskTelemetry";

/** 每秒刷新一次的当前时间（只在 active 时计时），用于运行中的耗时。 */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

/** 运行状态标签（原型 runs.css 的 .pill）。 */
export function RunPill({ status }: { status: string }) {
	const tone = { running: "run", success: "ok", failed: "fail" }[status] ?? "skip";
	return (
		<span className={`sf-pill sf-pill--${tone}`}>
			<i />
			{runStatusLabel(status)}
		</span>
	);
}

/** 打开运行时默认选中的节点：失败的节点，其次是执行中的节点。 */
function focusNode(run: RunView): string | null {
	const nodes = run.chains.flatMap((c) => c.nodes);
	return (
		nodes.find((n) => n.status === "failed")?.node_id ??
		nodes.find((n) => statusTone(n.status) === "current")?.node_id ??
		null
	);
}

const MASK = "••••••";

/** 入口节点和子流程入口节点中标记为敏感的参数名。 */
const secretParams = (doc: OrchestrationDocument) =>
	new Set(
		doc.nodes
			.flatMap((n) =>
				n.kind === "entry" || n.kind === "subflow_entry" ? n.params.filter((p) => p.secret) : [],
			)
			.map((p) => p.name),
	);

/** 输入里引用了敏感参数的键（这些输入在界面中打码）；异步任务节点是参数映射。 */
function secretInputs(node: OrchestrationNode | undefined, secrets: Set<string>): Set<string> {
	const values = node?.kind === "package" ? node.inputs : node?.kind === "async" ? node.params : {};
	if (secrets.size === 0) return new Set();
	return new Set(
		Object.entries(values)
			.filter(([, v]) =>
				[...secrets].some((s) => new RegExp(`params\\.${s}\\b`).test(JSON.stringify(v))),
			)
			.map(([k]) => k),
	);
}

const masked = (values: Record<string, unknown> | null, keys: Set<string>) =>
	values && Object.fromEntries(Object.entries(values).map(([k, v]) => [k, keys.has(k) ? MASK : v]));

/**
 * 运行视图：按运行绑定的编排版本渲染画布，通过 SSE 实时更新节点状态；
 * 右侧显示选中节点每次尝试的输入、输出、所在 Agent 和时间，没有选中时显示运行概要。
 */
export function RunPage({ runId }: { runId: string }) {
	const queryClient = useQueryClient();
	const run = useQuery({ queryKey: ["run", runId], queryFn: () => getRun(runId) });
	const running = !run.data || run.data.status === "running";
	// 运行结束后不再需要实时流（最后一条推送就是最终状态）。
	useEventSource(running ? runEventsPath(runId) : null, {
		run: (data) => queryClient.setQueryData(["run", runId], data as RunView),
		progress: (data) =>
			queryClient.setQueryData(["run", runId], (old: RunView | undefined) =>
				applyProgress(old, data as ProgressEvent),
			),
	});

	const orchestrationId = run.data?.orchestration_id;
	const versionNumber = run.data?.orchestration_version;
	const orchestration = useQuery({
		queryKey: ["orchestration", orchestrationId],
		queryFn: () => getOrchestration(orchestrationId as string),
		enabled: !!orchestrationId,
	});
	const version = useQuery({
		queryKey: ["orchestration", orchestrationId, "version", versionNumber],
		queryFn: () => getVersion(orchestrationId as string, versionNumber as number),
		enabled: !!orchestrationId && !!versionNumber,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const [selected, setSelected] = useState<string | null | undefined>(undefined);
	const now = useNow(running);
	// 子流程入口节点 ID → 画布上显示的实例（同一个子流程有多个实例时由区域标题切换）。
	const [picked, setPicked] = useState<Record<string, string>>({});
	const doc0 = version.data?.document;
	const states = useMemo(
		() => (run.data && doc0 ? nodeStates(run.data, doc0, picked) : new Map<string, NodeRunView>()),
		[run.data, doc0, picked],
	);
	const instances = useMemo(
		() => (run.data ? instancesByChain(run.data) : new Map<string, ChainRunView[]>()),
		[run.data],
	);
	const nodeChains = useMemo(() => (doc0 ? chainOfNode(doc0) : new Map<string, string>()), [doc0]);

	const error = run.error ?? version.error;
	if (error) return <p className="p-8 text-red-600">加载失败：{error.message}</p>;
	if (!run.data || !version.data) return <p className="p-8 text-gray-500">加载中…</p>;
	const data = run.data;
	const doc = version.data.document;
	const current = selected === undefined ? focusNode(data) : selected;
	const node = current ? doc.nodes.find((n) => n.id === current) : undefined;
	const secrets = secretParams(doc);
	const chainId = current ? nodeChains.get(current) : undefined;
	const instance = chainId ? pickedInstance(instances, picked, chainId) : undefined;

	return (
		<div className="sf-editor flex h-[calc(100vh-49px)] flex-col">
			<header className="sf-topbar">
				<Link
					to="/orchestrations/$id/runs"
					params={{ id: data.orchestration_id }}
					className="sf-link text-xs"
				>
					← 运行记录
				</Link>
				<h1>{orchestration.data?.name ?? "编排"}</h1>
				<span className="sf-tag">
					运行 <b title={data.id}>{shortId(data.id)}</b>
				</span>
				<RunPill status={data.status} />
				<span className="sf-tag">
					版本 <b>{data.orchestration_version}</b>
				</span>
				<span className="sf-tag">
					触发人 <b>{data.triggered_by}</b>
				</span>
				<span className="sf-tag">
					开始 <b>{formatTime(data.started_at)}</b>
				</span>
				<span className="sf-tag">
					耗时 <b>{durationBetween(data.started_at, data.ended_at, now)}</b>
				</span>
				<div className="ml-auto flex items-center gap-3">
					<CancelRunButton run={data} />
					<Link
						to="/orchestrations/$id"
						params={{ id: data.orchestration_id }}
						className="sf-btn sf-btn--ghost sf-btn--sm"
					>
						编辑编排
					</Link>
				</div>
			</header>
			<div className="flex min-h-0 flex-1">
				<div className="relative min-w-0 flex-1">
					<RunCanvas
						document={doc}
						states={states}
						now={now}
						selected={current}
						onSelect={setSelected}
						regions={{
							instances,
							picked,
							onPick: (chain, id) => setPicked((p) => ({ ...p, [chain]: id })),
						}}
					/>
				</div>
				<aside className="sf-panel w-[392px] shrink-0 overflow-y-auto border-l">
					{node ? (
						<NodeDetail
							key={node.id}
							node={node}
							state={states.get(node.id)}
							secretKeys={secretInputs(node, secrets)}
							now={now}
							chain={chainId}
							instance={instance}
							count={chainId ? (instances.get(chainId)?.length ?? 0) : 0}
							secrets={secrets}
						/>
					) : (
						<RunSummary run={data} doc={doc} secrets={secrets} />
					)}
				</aside>
			</div>
		</div>
	);
}

function JsonBlock({ value }: { value: unknown }) {
	return <pre className="sf-json">{JSON.stringify(value, null, 2)}</pre>;
}

function RunSummary({
	run,
	doc,
	secrets,
}: {
	run: RunView;
	doc: OrchestrationDocument;
	secrets: Set<string>;
}) {
	const entry = doc.nodes.find((n) => n.kind === "entry");
	const decls: ParamDecl[] = entry?.kind === "entry" ? entry.params : [];
	return (
		<>
			<Section title="运行">
				<dl className="sf-kv">
					<dt>运行 ID</dt>
					<dd className="sf-mono">{run.id}</dd>
					<dt>状态</dt>
					<dd>
						<RunPill status={run.status} />
					</dd>
					<dt>编排版本</dt>
					<dd className="sf-mono">{run.orchestration_version}</dd>
					<dt>触发人</dt>
					<dd>{run.triggered_by}</dd>
					<dt>开始</dt>
					<dd className="sf-mono">{formatTime(run.started_at)}</dd>
					<dt>结束</dt>
					<dd className="sf-mono">{formatTime(run.ended_at)}</dd>
					{run.cancel && (
						<>
							<dt>取消</dt>
							<dd>
								{run.cancel.requested_by} · {formatTime(run.cancel.requested_at)}
								{run.cancel.forced_at && `（强制终止于 ${formatTime(run.cancel.forced_at)}）`}
							</dd>
						</>
					)}
				</dl>
			</Section>
			<Section title="入口参数" aside={`${decls.length} 个`}>
				{decls.length === 0 ? (
					<p className="sf-hint">没有入口参数。</p>
				) : (
					<dl className="sf-kv">
						{decls.map((p) => (
							<div key={p.name} className="contents">
								<dt className="sf-mono">{p.name}</dt>
								<dd className="sf-mono">
									{secrets.has(p.name) ? MASK : JSON.stringify(run.params[p.name] ?? null)}
								</dd>
							</div>
						))}
					</dl>
				)}
			</Section>
			<Section title="链" aside={`${run.chains.length} 条`}>
				<ul className="space-y-1">
					{run.chains.map((c) => (
						<li
							key={c.id}
							className="flex items-center justify-between gap-2"
							style={{ paddingLeft: c.depth * 14 }}
						>
							<span className="sf-mono" title={c.id}>
								{c.depth === 0
									? `主链 · ${c.chain_id}`
									: `子流程 ${c.chain_id} · ${shortId(c.id)}（由 ${c.async_node_id} 触发）`}
							</span>
							<span className={`sf-status sf-status--${statusTone(c.status)}`}>
								<i />
								{runStatusLabel(c.status)}
							</span>
						</li>
					))}
				</ul>
				<p className="sf-hint">点击画布上的节点，查看它每次尝试的输入、输出、所在 Agent 和时间。</p>
			</Section>
		</>
	);
}

function NodeDetail({
	node,
	state,
	secretKeys,
	now,
	chain,
	instance,
	count,
	secrets,
}: {
	node: OrchestrationNode;
	state: NodeRunView | undefined;
	secretKeys: Set<string>;
	now: number;
	/** 节点所在链的起点节点 ID。 */
	chain: string | undefined;
	/** 画布上显示的该链实例；子流程还没有被触发时为空。 */
	instance: ChainRunView | undefined;
	/** 这条链在运行中的实例数。 */
	count: number;
	secrets: Set<string>;
}) {
	const titles = usePackageTitles();
	const title =
		node.kind === "package"
			? (titles.get(`${node.package}/${node.node}`) ?? `${node.package}/${node.node}`)
			: KIND_LABEL[node.kind];
	const status = state?.status ?? "pending";
	const tone = statusTone(status);
	const attempts = [...(state?.attempts ?? [])].reverse();
	return (
		<>
			<section className="sf-sec sf-ins-head">
				<div className="flex items-center gap-2">
					<KindChip kind={node.kind} />
					<span className="sf-mono text-[var(--sf-text-2)]">{node.id}</span>
					<span className={`sf-status sf-status--${tone}`}>
						<i />
						{statusLabel(status)}
					</span>
				</div>
				<h2>{title}</h2>
				<FailureSummary node={node} state={state} />
			</section>
			{chain && <ChainInstance chain={chain} instance={instance} count={count} secrets={secrets} />}
			<TaskTelemetry attempts={state?.attempts ?? []} />
			<Section title="尝试" aside={`${attempts.length} 次`}>
				{attempts.length === 0 && status !== "skipped" && status !== "cancelled" && (
					<p className="sf-hint">还没有开始执行。</p>
				)}
				<div className="space-y-3">
					{attempts.map((a) => (
						<Attempt key={a.task_id} attempt={a} secretKeys={secretKeys} now={now} />
					))}
				</div>
			</Section>
		</>
	);
}

function Attempt({
	attempt,
	secretKeys,
	now,
}: {
	attempt: AttemptView;
	secretKeys: Set<string>;
	now: number;
}) {
	return (
		<article className="sf-card sf-attempt" data-run={statusTone(attempt.status)}>
			<header>
				<b>第 {attempt.attempt} 次</b>
				{attempt.attempt > 1 && <span className="sf-hint">重试</span>}
				<span className={`sf-status sf-status--${statusTone(attempt.status)}`}>
					<i />
					{statusLabel(attempt.status)}
				</span>
			</header>
			<dl className="sf-kv">
				<dt>Agent</dt>
				<dd className="sf-mono">{attempt.agent ?? "控制面"}</dd>
				<dt>排队</dt>
				<dd className="sf-mono">{formatTime(attempt.queued_at)}</dd>
				<dt>开始</dt>
				<dd className="sf-mono">{formatTime(attempt.started_at)}</dd>
				<dt>结束</dt>
				<dd className="sf-mono">{formatTime(attempt.ended_at)}</dd>
				<dt>耗时</dt>
				<dd className="sf-mono">
					{attempt.started_at ? durationBetween(attempt.started_at, attempt.ended_at, now) : "—"}
				</dd>
			</dl>
			{attempt.error && (
				<>
					<ErrorKindTag kind={attempt.error.kind} />
					<p className="sf-err">{attempt.error.message}</p>
				</>
			)}
			<h4>输入</h4>
			{attempt.inputs ? (
				<JsonBlock value={masked(attempt.inputs, secretKeys)} />
			) : (
				<p className="sf-hint">派发时才解析输入。</p>
			)}
			<h4>输出</h4>
			{attempt.outputs ? <JsonBlock value={attempt.outputs} /> : <p className="sf-hint">—</p>}
		</article>
	);
}

/** 节点所在的链实例：主链或某个子流程实例的状态、参数和触发它的异步任务节点。 */
function ChainInstance({
	chain,
	instance,
	count,
	secrets,
}: {
	chain: string;
	instance: ChainRunView | undefined;
	count: number;
	secrets: Set<string>;
}) {
	if (!instance) {
		return (
			<Section title="子流程实例">
				<p className="sf-hint">子流程 {chain} 在这次运行中还没有被触发。</p>
			</Section>
		);
	}
	const main = instance.depth === 0;
	return (
		<Section
			title={main ? "主链" : "子流程实例"}
			aside={count > 1 ? `共 ${count} 个实例，在区域标题切换` : undefined}
		>
			<dl className="sf-kv">
				<dt>{main ? "链" : "子流程"}</dt>
				<dd className="sf-mono">{chain}</dd>
				<dt>实例 ID</dt>
				<dd className="sf-mono" title={instance.id}>
					{shortId(instance.id)}
				</dd>
				<dt>状态</dt>
				<dd>
					<span className={`sf-status sf-status--${statusTone(instance.status)}`}>
						<i />
						{runStatusLabel(instance.status)}
					</span>
				</dd>
				{!main && (
					<>
						<dt>触发</dt>
						<dd className="sf-mono">
							{instance.async_node_id}（第 {instance.depth} 层）
						</dd>
						<dt>参数</dt>
						<dd>
							<JsonBlock
								value={Object.fromEntries(
									Object.entries(instance.params).map(([k, v]) => [k, secrets.has(k) ? MASK : v]),
								)}
							/>
						</dd>
					</>
				)}
			</dl>
		</Section>
	);
}
