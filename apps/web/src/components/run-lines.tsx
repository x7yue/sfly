import { isActiveStatus } from "@sfly/schema";
import { cn } from "cn";
import type { CSSProperties } from "react";
import { chainProgressText } from "#/components/chain-progress";
import { runNodeName } from "#/components/node-name";
import { nodeStatusView, StatusDot } from "#/components/status";
import { LIST_LABEL, moreLabel } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";

/**
 * 线路（外壳页方案 4.1）：一个运行的每条链画成一条线，节点是站，状态点取自状态表；进入执行中节点的那一段是青色，
 * 子流程从触发它的异步任务节点那一列分出，分支线是调度连线的青色虚线。站很多时按 {@link foldStations} 折叠。
 * 控制台的运行块和运行监控的概览用它（输入只要链实例的父链、异步任务节点和各节点状态）。
 */

export interface LineNode {
	node_id: string;
	display_name?: string | undefined;
	status: string;
}

export interface LineChain {
	/** 链实例 ID。 */
	id: string;
	/** 链的名称：「主链」或「子流程 <名称>」。 */
	label: string;
	/** 子流程实例的短 ID，写在名称后面（运行监控的概览）；不给时不写。 */
	instance?: string | undefined;
	parent_chain_instance_id: string | null;
	/** 触发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: string | null;
	/** 链上的节点，按链上的顺序。 */
	nodes: readonly LineNode[];
}

/**
 * 线路上的一站：一个节点，或折起来的一段（「已完成 N 个」在当前站之前，「还有 N 个」在之后）。
 * 折起来的一段画成它最后一个节点（挨着画出来的那一站）的状态。
 */
export type Station =
	| { kind: "node"; node: LineNode; index: number }
	| { kind: "fold"; side: "done" | "rest"; start: number; count: number; status: string };

/** 一条链超过这么多个节点就折叠；折叠后至多 6 站（加上画出来的失败节点）。 */
export const LINE_MAX_STATIONS = 7;

/**
 * 长链折叠（外壳页方案 4.2）：节点不超过 `max` 个时每个节点一站；超过时只画当前站（进行中的节点，没有时是第一个
 * 待执行的节点）前面最后一站、当前站和之后两站，其余折成「已完成 N 个」「还有 N 个」。失败的节点总是画出来，
 * 不折进「已完成」；只折一个节点时直接画它（一站和一段折叠一样宽）。都结束了的链只画最后一站。
 */
export function foldStations(nodes: readonly LineNode[], max = LINE_MAX_STATIONS): Station[] {
	const all: Station[] = nodes.map((node, index) => ({ kind: "node", node, index }));
	if (nodes.length <= max) return all;
	const active = nodes.findIndex((n) => isActiveStatus(n.status));
	const open = active >= 0 ? active : nodes.findIndex((n) => n.status === "pending");
	const anchor = open >= 0 ? open : nodes.length;
	const shown = (i: number) =>
		(i >= anchor - 1 && i <= anchor + 2) || nodes[i]?.status === "failed";
	const stations: Station[] = [];
	for (let i = 0; i < nodes.length; ) {
		let end = i;
		while (end < nodes.length && !shown(end)) end++;
		if (end - i > 1) {
			stations.push({
				kind: "fold",
				side: i < anchor ? "done" : "rest",
				start: i,
				count: end - i,
				status: nodes[end - 1]?.status ?? "pending",
			});
			i = end;
		} else {
			stations.push(all[i] as Station);
			i++;
		}
	}
	return stations;
}

export interface LineRow {
	chain: LineChain;
	/** 第一站所在的列（从 0 起）：子流程从触发它的异步任务节点那一站的列开始。 */
	column: number;
	/** 分出这条子流程的那一行（`rows` 的下标）；主链和父链不在这份数据里的链为 null。 */
	parent: number | null;
	stations: Station[];
}

/**
 * 一个运行的线路怎么排：主链在第一行，每条子流程排在它的父链之后，从触发它的异步任务节点所在的列开始
 * （那个节点被折进一段时，从那一段的列开始）。同一条链分出的几条子流程，列靠右的排在前面：
 * 后排的分支竖线只经过前面那些分支左侧的空白，不会穿过它们的线。
 */
export function layoutLines(
	chains: readonly LineChain[],
	max = LINE_MAX_STATIONS,
): { rows: LineRow[]; columns: number } {
	const ids = new Set(chains.map((c) => c.id));
	const children = new Map<string | null, LineChain[]>();
	for (const chain of chains) {
		const parent =
			chain.parent_chain_instance_id !== null && ids.has(chain.parent_chain_instance_id)
				? chain.parent_chain_instance_id
				: null;
		children.set(parent, [...(children.get(parent) ?? []), chain]);
	}
	const rows: LineRow[] = [];
	const place = (chain: LineChain, column: number, parent: number | null) => {
		const stations = foldStations(chain.nodes, max);
		const row = rows.push({ chain, column, parent, stations }) - 1;
		const columnOf = new Map<string, number>();
		stations.forEach((station, k) => {
			if (station.kind === "node") columnOf.set(station.node.node_id, k);
			else {
				for (const node of chain.nodes.slice(station.start, station.start + station.count)) {
					columnOf.set(node.node_id, k);
				}
			}
		});
		const branches = (children.get(chain.id) ?? []).map((child) => ({
			child,
			column: column + (columnOf.get(child.async_node_id ?? "") ?? 0),
		}));
		branches.sort((a, b) => b.column - a.column);
		for (const branch of branches) place(branch.child, branch.column, row);
	};
	for (const root of children.get(null) ?? []) place(root, 0, null);
	const columns = Math.max(1, ...rows.map((r) => r.column + r.stations.length));
	return { rows, columns };
}

const isRunning = (station: Station | undefined) =>
	station?.kind === "node" && nodeStatusView(station.node.status).kind === "running";

const foldLabel = (station: Extract<Station, { kind: "fold" }>) =>
	station.side === "done" ? `已完成 ${station.count} 个` : moreLabel(station.count);

/**
 * 线路。每行是一条链：名称、各站（站名在点的下面）、已完成数 / 节点数。所有行共用一套列（CSS subgrid），
 * 子流程的第一站和父链上触发它的那一站对齐，分支竖线从父链那一站画下来。
 */
export function RunLines({
	chains,
	className,
}: {
	chains: readonly LineChain[];
	className?: string;
}) {
	const { rows, columns } = layoutLines(chains);
	return (
		<ul
			aria-label={LIST_LABEL.chainProgress}
			data-viz
			style={{ "--line-columns": columns } as CSSProperties}
			className={cn(
				"m-0 grid list-none grid-cols-[fit-content(10rem)_repeat(var(--line-columns),minmax(0,5.5rem))_minmax(0,1fr)_auto] gap-y-1.5 p-0",
				className,
			)}
		>
			{rows.map((row, r) => (
				<li key={row.chain.id} className="col-span-full grid grid-cols-subgrid">
					<span className="flex min-w-0 pr-3 text-xs text-fg-3">
						<Truncate>{row.chain.label}</Truncate>
						{row.chain.instance && (
							<span data-chain-id className="ml-1.5 flex-none font-mono">
								{row.chain.instance}
							</span>
						)}
					</span>
					<ol className="col-[2/-3] m-0 grid list-none grid-cols-subgrid p-0">
						{row.stations.map((station, k) => (
							<StationCell
								key={station.kind === "node" ? station.node.node_id : `fold-${station.start}`}
								station={station}
								column={row.column + k}
								next={row.stations[k + 1]}
								branchUp={k === 0 && row.parent !== null ? r - row.parent : 0}
							/>
						))}
					</ol>
					<span className="pl-2 text-right font-mono text-xs text-fg-3">
						{chainProgressText(row.chain.nodes)}
					</span>
				</li>
			))}
		</ul>
	);
}

/** 一行高 44px（点 20px、站名 18px、行间 6px）：分支竖线按它算长度。 */
const BRANCH_LINE =
	"top-[calc(0.875rem-var(--branch-up)*2.75rem)] h-[calc(var(--branch-up)*2.75rem-0.5rem)]";

function StationCell({
	station,
	column,
	next,
	branchUp,
}: {
	station: Station;
	column: number;
	next: Station | undefined;
	/** 分支竖线往上画几行（0 是不画）。 */
	branchUp: number;
}) {
	const node = station.kind === "node" ? station.node : undefined;
	const status = node ? nodeStatusView(node.status) : undefined;
	const kind = nodeStatusView(station.kind === "fold" ? station.status : station.node.status).kind;
	return (
		<li style={{ gridColumnStart: column + 1 }} className="relative min-w-0">
			<span className="relative flex h-5 items-center">
				{next && (
					<span
						aria-hidden
						className={cn(
							"absolute top-1/2 -right-1 left-1 h-px",
							isRunning(next) ? "bg-signal-line" : "bg-border-strong",
						)}
					/>
				)}
				{branchUp > 0 && (
					<span
						aria-hidden
						style={{ "--branch-up": branchUp } as CSSProperties}
						className={cn(
							"absolute left-[3.5px] border-l border-dashed border-signal-line",
							BRANCH_LINE,
						)}
					/>
				)}
				{/* 站点盖在线上：待执行的空心圈要有底色，线才不会从圈里穿过。 */}
				<StatusDot kind={kind} className="rounded-full bg-surface" />
			</span>
			<span
				className={cn(
					"flex min-w-0 pr-2 pl-2.5 text-xs",
					station.kind === "fold"
						? "text-fg-3"
						: kind === "running"
							? "font-mono text-signal-fg"
							: node?.status === "pending"
								? "font-mono text-fg-3"
								: "font-mono text-fg-2",
				)}
			>
				<Truncate>
					{node ? runNodeName(node) : station.kind === "fold" ? foldLabel(station) : ""}
				</Truncate>
				{status && <span className="sr-only">（{status.label}）</span>}
			</span>
		</li>
	);
}

/**
 * 线路缩略（控制台的紧凑行）：一条链的各站只画点和线，折叠规则同 {@link foldStations}，折起来的一段画成一截虚线。
 * 读屏读作「主链 5/10」。
 */
export function RunLineThumb({ chain }: { chain: LineChain }) {
	const stations = foldStations(chain.nodes);
	const text = `${chain.label} ${chainProgressText(chain.nodes)}`;
	return (
		<span
			role="img"
			aria-label={text}
			title={text}
			data-viz
			className="inline-flex flex-none items-center"
		>
			{stations.map((station, k) => (
				<span
					key={station.kind === "node" ? station.node.node_id : `fold-${station.start}`}
					className="inline-flex items-center"
				>
					{k > 0 && (
						<span
							aria-hidden
							className={cn("h-px w-2", isRunning(station) ? "bg-signal-line" : "bg-border-strong")}
						/>
					)}
					{station.kind === "node" ? (
						<StatusDot kind={nodeStatusView(station.node.status).kind} />
					) : (
						<span aria-hidden className="w-3 border-t border-dashed border-border-strong" />
					)}
				</span>
			))}
		</span>
	);
}
