import { ChevronDownIcon, ListFilterIcon } from "lucide-react";
import { useId, useState } from "react";
import { StatusDot } from "#/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ChartGroup, isActive, isFailed } from "./chart-groups";
import { PLATFORM_KEY } from "./monitor-state";
import { chainLabel } from "./run-model";

/**
 * 「节点：全部节点 ▾」多选筛选（原型 nodeFilterMenu）：按链整组勾选、搜索节点、快速选择（执行中、失败、有数据、
 * 全选、清空），可以单独勾选平台自带图表。选中全部时等于不筛选（null）。
 */
export function NodeFilter({
	label,
	groups,
	filter,
	hasData,
	onChange,
}: {
	label: string;
	groups: readonly ChartGroup[];
	filter: ReadonlySet<string> | null;
	hasData: (group: ChartGroup) => boolean;
	onChange: (filter: ReadonlySet<string> | null) => void;
}) {
	const [search, setSearch] = useState("");
	const all = [...groups.map((g) => g.key), PLATFORM_KEY];
	const checked = (key: string) => !filter || filter.has(key);
	const current = () => new Set(filter ?? all);
	/** 设置筛选；选中全部时为 null。 */
	const set = (keys: Iterable<string>) => {
		const next = new Set([...keys].filter((k) => all.includes(k)));
		onChange(next.size === all.length ? null : next);
	};
	const toggle = (keys: readonly string[], on: boolean) => {
		const next = current();
		for (const k of keys) {
			if (on) next.add(k);
			else next.delete(k);
		}
		set(next);
	};
	const pick = (match: (g: ChartGroup) => boolean) => set(groups.filter(match).map((g) => g.key));

	const q = search.trim().toLowerCase();
	const visible = groups.filter(
		(g) =>
			!q ||
			g.ref.nodeId.toLowerCase().includes(q) ||
			`${g.entry.package}/${g.entry.node}`.toLowerCase().includes(q),
	);
	const chains = [...new Map(visible.map((g) => [g.chain.id, g.chain])).values()];
	const selectedNodes = filter ? groups.filter((g) => filter.has(g.key)).length : groups.length;

	return (
		<Popover>
			<PopoverTrigger
				data-active={filter ? true : undefined}
				className="inline-flex h-6.5 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 text-sm text-fg-1 hover:bg-raised-2 data-active:border-selected [&_svg]:size-3.5 [&_svg]:text-fg-3"
			>
				<ListFilterIcon aria-hidden />
				<span>
					节点：<b className="font-medium">{label}</b>
				</span>
				<ChevronDownIcon aria-hidden />
			</PopoverTrigger>
			<PopoverContent
				aria-label="按节点筛选图表"
				align="start"
				className="flex w-90 flex-col gap-2 p-2.5"
			>
				<Input
					aria-label="搜索节点 ID 或名称"
					placeholder="搜索节点 ID 或名称"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<div className="flex flex-wrap items-center gap-1 text-xs">
					<span className="mr-1 text-fg-3">快速选择</span>
					<Button size="sm" onClick={() => pick(isActive)}>
						执行中
					</Button>
					<Button size="sm" onClick={() => pick(isFailed)}>
						失败
					</Button>
					<Button size="sm" onClick={() => pick(hasData)}>
						有数据
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onChange(null)}>
						全选
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onChange(new Set())}>
						清空
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-auto border-y border-border-soft py-1">
					{chains.map((chain) => {
						const members = visible.filter((g) => g.chain.id === chain.id);
						const keys = members.map((g) => g.key);
						const label = chainLabel(chain);
						return (
							<fieldset key={chain.id} aria-label={label} className="m-0 border-0 p-0 py-0.5">
								<Row name={label} checked={keys.every(checked)} onChange={(on) => toggle(keys, on)}>
									<b className="font-medium">{label}</b>
									<span className="ml-auto text-xs text-fg-3">{members.length} 个节点</span>
								</Row>
								{members.map((g) => (
									<Row
										key={g.key}
										name={g.ref.nodeId}
										checked={checked(g.key)}
										onChange={(on) => toggle([g.key], on)}
										indent
									>
										<StatusDot kind={g.status.kind} />
										<span className="font-mono">{g.ref.nodeId}</span>
										<span className="min-w-0 truncate text-fg-3">
											{g.entry.package}/{g.entry.node}
										</span>
										<span className="ml-auto font-mono text-2xs text-fg-3">
											{g.entry.charts.length}
										</span>
									</Row>
								))}
							</fieldset>
						);
					})}
					{chains.length === 0 && q && (
						<p className="m-0 px-1.5 py-2 text-xs text-fg-3">没有匹配的节点。</p>
					)}
					<Row
						name="平台自带图表"
						checked={checked(PLATFORM_KEY)}
						onChange={(on) => toggle([PLATFORM_KEY], on)}
					>
						<b className="font-medium">平台自带图表</b>
						<span className="ml-auto text-xs text-fg-3">4 张</span>
					</Row>
				</div>
				<div className="flex items-center gap-2 text-xs">
					<span className="text-fg-3">
						{filter ? `已选 ${selectedNodes} 个节点` : "显示全部节点"}
					</span>
					<span className="flex-1" />
					<PopoverClose render={<Button size="sm" />}>完成</PopoverClose>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function Row({
	name,
	checked,
	onChange,
	indent,
	children,
}: {
	name: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	indent?: boolean;
	children: React.ReactNode;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className="flex cursor-pointer items-center gap-2 rounded-sm py-1.25 pr-1.5 text-sm hover:bg-raised-2"
			style={{ paddingLeft: indent ? 22 : 6 }}
		>
			<Checkbox
				id={id}
				aria-label={name}
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{children}
		</label>
	);
}
