import { isActiveStatus } from "@sfly/schema";
import { cn } from "cn";
import type { CSSProperties } from "react";
import {
	chainProgressName,
	chainProgressText,
	chainSkippedText,
} from "#/components/chain-progress";
import { runNodeName } from "#/components/node-name";
import { nodeStatusView, StatusDot } from "#/components/status";
import { FOLDED_LABEL, LIST_LABEL, moreLabel } from "#/lib/copy";
import { nodeStatusDisplay } from "#/lib/node-status";
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
 * 线路上的一站：一个节点，或折起来的一段。当前站之前的段是 `done`（都算已完成：成功、已停止）或 `ended`
 * （一样状态、但不算完成的节点：取消的运行里已取消的节点、失败之后被跳过的节点），之后的是 `rest`。
 * 折起来的一段画成它最后一个节点（挨着画出来的那一站）的状态。
 */
export type Station =
	| { kind: "node"; node: LineNode; index: number }
	| {
			kind: "fold";
			side: "done" | "ended" | "rest";
			start: number;
			count: number;
			status: string;
	  };

/** 一条链超过这么多个节点就折叠；折叠后至多 6 站（加上画出来的失败节点）。 */
export const LINE_MAX_STATIONS = 7;

/**
 * 长链折叠（外壳页方案 4.2）：节点不超过 `max` 个时每个节点一站；超过时只画当前站（进行中的节点，没有时是第一个
 * 待执行的节点）前面最后一站、当前站和之后两站，其余折成「已完成 N 个」「还有 N 个」。失败的节点总是画出来，
 * 不折进「已完成」；不算完成的节点（已取消、已跳过）也不折进「已完成」，连着的一样状态折成一段（「已取消 N 个」「已跳过 N 个」）。
 * 只折一个节点时直接画它（一站和一段折叠一样宽）。都结束了的链只画最后一站。
 */
export function foldStations(nodes: readonly LineNode[], max = LINE_MAX_STATIONS): Station[] {
	const all: Station[] = nodes.map((node, index) => ({ kind: "node", node, index }));
	if (nodes.length <= max) return all;
	const active = nodes.findIndex((n) => isActiveStatus(n.status));
	const open = active >= 0 ? active : nodes.findIndex((n) => n.status === "pending");
	const anchor = open >= 0 ? open : nodes.length;
	const shown = (i: number) =>
		(i >= anchor - 1 && i <= anchor + 2) || nodes[i]?.status === "failed";
	// 当前站之前，算已完成的节点一起折，不算完成的按状态分开折；之后的都是「还有」。
	const group = (i: number) => {
		if (i >= anchor) return "rest";
		const status = nodes[i]?.status ?? "";
		return nodeStatusDisplay(status)?.done ? "done" : status;
	};
	const stations: Station[] = [];
	for (let i = 0; i < nodes.length; ) {
		let end = i;
		while (end < nodes.length && !shown(end) && group(end) === group(i)) end++;
		if (end - i > 1) {
			const kind = group(i);
			stations.push({
				kind: "fold",
				side: kind === "rest" || kind === "done" ? kind : "ended",
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

/** 折起来的一段写什么：「已完成 3 个」「已取消 4 个」「还有 5 个」。 */
export function foldLabel(station: Extract<Station, { kind: "fold" }>): string {
	switch (station.side) {
		case "done":
			return FOLDED_LABEL.done(station.count);
		case "ended":
			return FOLDED_LABEL.ended(nodeStatusView(station.status).label, station.count);
		case "rest":
			return moreLabel(station.count);
	}
}

/** 链名那一列最宽 10rem（再长的链名截断，悬停看全名）。 */
const LABEL_COLUMN_MAX = "10rem";

/**
 * 站的格子最宽（放得下时每一站取这么宽；站名比它长的列例外，各取自己站名的宽度，最宽 18rem）：站很少时不平分整行，
 * 多出来的宽度留在行尾。12rem 够写一个常见的节点 ID（等宽 12px，约 20 个字符）加上线和点。
 */
export const LINE_CELL = "12rem";

/** `labelColumnWidth` 的估算里为「估少了」多留的 0.375rem：算「放不放得下」时减掉它，让这一项也只往小里估。 */
const LABEL_ESTIMATE_MARGIN = "0.375rem";

/**
 * 计数那一列预留的宽度，算「放不放得下」（`--line-room`）用：最短的「1/1」加左边距（等宽 12px 三个字符加 0.5rem），只往小里估
 * （计数更宽时线路本来就按内容取宽，只是放得下的界限差几十像素）。估大了的话，放得下时多出来的宽度会摊到每一站的格子上，
 * 格子就超过 {@link LINE_CELL}。
 */
const COUNT_COLUMN = "1.75rem";

/** 链名在 `text-xs`（0.75rem）里大概有多宽（rem）：全角字一个字宽，其余按 0.6 个字宽估。 */
const labelRem = (text: string) =>
	[...text].reduce((width, ch) => width + (ch.charCodeAt(0) > 0x2e7f ? 0.75 : 0.75 * 0.6), 0);

/**
 * 几块线路共用的链名列宽（控制台里上下排着的运行块）：按这些块里最长的链名估一个宽度，给每块的 {@link RunLines}
 * 的 `labelWidth`，各块的线路才从同一个横坐标开始（每块自己取链名的宽度，「主链」和「子流程 监控」的块就错开了）。
 * 是估算（见 {@link labelRem}）：估多了只是多一点空白，估少了链名的末尾省略（悬停看全名）；最宽 10rem。
 */
export function labelColumnWidth(labels: readonly string[]): string {
	const widest = Math.max(0, ...labels.map(labelRem));
	// 加上名称右边的 0.75rem 间距和 0.375rem 余量。
	return `min(${LABEL_COLUMN_MAX}, ${(widest + 1.125).toFixed(3)}rem)`;
}

/**
 * 线路。每行是一条链：名称、各站（站名在点的下面）、已完成数 / 节点数。所有行共用一套列（CSS subgrid），
 * 子流程的第一站和父链上触发它的那一站对齐，分支竖线从父链那一站画下来。
 * 链名那一列默认取这块里最长链名的宽度；上下排着几块时传 `labelWidth`（{@link labelColumnWidth}），各块对齐。
 */
export function RunLines({
	chains,
	className,
	labelWidth,
}: {
	chains: readonly LineChain[];
	className?: string;
	/** 链名那一列的宽度（CSS 长度）；不给时取这块里最长链名的宽度。 */
	labelWidth?: string | undefined;
}) {
	const { rows, columns } = layoutLines(chains);
	return (
		// 外面这层是容器（`@container`）：站的格子要知道这一块有多宽，才分得出「放得下」和「放不下」，见下面 `ul` 和站格里的垫片。
		<div className={cn("@container", className)}>
			<ul
				aria-label={LIST_LABEL.chainProgress}
				data-viz
				style={
					{
						"--line-columns": columns,
						"--line-cell": LINE_CELL,
						...(labelWidth ? { "--line-label": labelWidth } : {}),
						// 链名那一列的宽度（给了 `labelWidth` 就是它，没给时按链名估一个，只用来算这一块要多宽才算放得下）。
						"--line-label-est": labelColumnWidth(chains.map((c) => c.label)),
						"--line-room": `calc(var(--line-columns) * var(--line-cell) + var(--line-label, var(--line-label-est)) - ${LABEL_ESTIMATE_MARGIN} + ${COUNT_COLUMN})`,
					} as CSSProperties
				}
				className={cn(
					// 站名那几列：每列最宽 18rem、各取自己站名的宽度（`auto`），放不下时按各列缺的宽度均分：短站名让出的宽度给长站名，
					// 长节点 ID 的站名（常常正好是失败的那个节点）不再和短站名平分同样的宽度。
					// 宽度有两种情形，分界是「每一站取 `--line-cell`、加上链名和计数，这一块放不放得下」（`--line-room`）：
					// ① 放不下（或刚好）：`min-width` 是整行（容器宽度，台阶：容器不比 `--line-room` 宽就是整行，宽了就是 0），
					//    站名那几列分掉整行剩下的宽度（auto 的列在 `justify-content: normal` 下平均拉伸），短链（2–4 站）不再挤在左边一两百像素；
					// ② 放得下：线路只占它要的宽度（`w-fit`、`min-width` 为 0），除最后一列外每一站的格子是 `--line-cell`（站格里有一个这么宽的垫片
					//    撑着，站名更长的列取站名的宽度），**最后一列取站名的宽度**：计数紧跟在末站的站名后面，多出来的宽度只留在计数之后
					//    （最后一站也是 192px 的话，末站名后面先空一百多像素才是计数，看起来像少了一站）。
					// 计数那一列是 `max-content`（不是 auto，不跟着拉伸），链名那一列也是。
					"m-0 grid w-fit max-w-full min-w-[clamp(0px,calc((var(--line-room)-100cqw)*1000),100cqw)] list-none grid-cols-[var(--line-label,max-content)_repeat(var(--line-columns),minmax(0,auto))_max-content] gap-y-1.5 p-0",
				)}
			>
				{rows.map((row, r) => (
					<li key={row.chain.id} className="col-span-full grid grid-cols-subgrid">
						{/* 第一列取链名的全宽（最宽 10rem）：站名那几列分余量时不和它抢。 */}
						<span className="flex min-w-0 max-w-40 pr-3 text-xs text-fg-3">
							<Truncate>{row.chain.label}</Truncate>
							{row.chain.instance && (
								<span data-chain-id className="ml-1.5 flex-none font-mono">
									{row.chain.instance}
								</span>
							)}
						</span>
						<ol className="col-[2/-2] m-0 grid list-none grid-cols-subgrid p-0">
							{row.stations.map((station, k) => (
								<StationCell
									key={station.kind === "node" ? station.node.node_id : `fold-${station.start}`}
									station={station}
									column={row.column + k}
									capped={row.column + k < columns - 1}
									next={row.stations[k + 1]}
									branchUp={k === 0 && row.parent !== null ? r - row.parent : 0}
								/>
							))}
						</ol>
						<ChainCount nodes={row.chain.nodes} />
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * 一条链的计数：「已完成数 / 节点数」，有被跳过的节点时下面一行单独写「跳过 2」（被跳过的不算已完成）。
 * 放在最后一列（auto）：站名那几列把余量用完时，计数照样有位置；两行叠着，不占更宽的列。
 */
function ChainCount({ nodes }: { nodes: readonly LineNode[] }) {
	const skipped = chainSkippedText(nodes);
	return (
		<span className="col-[-2/-1] flex flex-col items-end pl-2 text-xs whitespace-nowrap text-fg-3">
			<span className="font-mono">{chainProgressText(nodes)}</span>
			{skipped && <span data-skipped-count>{skipped}</span>}
		</span>
	);
}

/** 一行高 44px（点 20px、站名 18px、行间 6px）：分支竖线按它算长度。 */
const BRANCH_LINE =
	"top-[calc(0.875rem-var(--branch-up)*2.75rem)] h-[calc(var(--branch-up)*2.75rem-0.5rem)]";

function StationCell({
	station,
	column,
	capped,
	next,
	branchUp,
}: {
	station: Station;
	column: number;
	/** 不是最后一列：放得下时格子撑到 `--line-cell`（垫片）；最后一列取站名的宽度，计数紧跟在后面。 */
	capped: boolean;
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
				// 站名最宽 18rem（列取站名的宽度，不被一个很长的节点 ID 撑开）；列被拉伸之后站点的格子比站名宽，连着下一站的线画满整格。
				className={cn(
					"flex min-w-0 max-w-72 pr-1 pl-2.5 text-xs",
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
			{/* 垫片（最后一列没有）：放得下时（容器宽度够 `--line-room`）把这一列撑到 `--line-cell`，放不下时宽度为 0，列按站名的宽度分整行。
			    宽度是个「台阶」：容器宽出 `--line-room` 1px 以上就是满的，不足就是 0（差值乘 1000 再夹到 0 到 `--line-cell` 之间）。 */}
			{capped && (
				<span
					aria-hidden
					className="block h-0 w-[clamp(0px,calc((100cqw-var(--line-room))*1000),var(--line-cell))] max-w-full"
				/>
			)}
		</li>
	);
}

/**
 * 线路缩略（控制台的紧凑行）：一条链的各站只画点和线，折叠规则同 {@link foldStations}，折起来的一段画成一截虚线。
 * 读屏读作「主链 5/10」。
 */
export function RunLineThumb({ chain }: { chain: LineChain }) {
	const stations = foldStations(chain.nodes);
	const text = chainProgressName(chain.label, chain.nodes);
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
