import type { ActionSummaryView } from "@sfly/schema";
import { cn } from "cn";
import type { Ref } from "react";
import { StatusDot } from "#/components/status";
import { ACTION_PAGE } from "#/lib/copy";
import { formatInteger } from "#/lib/format";
import { untrustedPlain } from "#/lib/untrusted-text";
import { LOG_TIME_KINDS, type LogTimeKind } from "#/monitor/log-time-kind";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Truncate } from "@/components/ui/truncate";
import type { ActionFilter } from "./action-details";
import { failedTotal, withFailed, withName } from "./action-filter";
import { actionCount } from "./action-table";

const TIME_OPTIONS = LOG_TIME_KINDS.map(([value, label]) => ({ value, label }));

/**
 * 「动作」页签的工具条和一行总数：按名称筛选的下拉、「只看失败」开关、表格里的时间（Agent 时间 / 控制面时间），
 * 下面是一行总数，每种名称的个数和「失败 N」本身就是筛选按钮（`aria-pressed`），和下拉、开关是同一份筛选条件。
 * 点按钮不会把它换掉：焦点留在刚操作的控件上。名称很多时（SDK 超过 100 种会警告）个数那一块限高、自己滚动。
 */
export function ActionToolbar({
	summary,
	filter,
	onFilter,
	timeKind,
	onTimeKind,
	nameSelect,
	failedToggle,
}: {
	summary: ActionSummaryView;
	filter: ActionFilter;
	onFilter: (next: ActionFilter) => void;
	timeKind: LogTimeKind;
	onTimeKind: (kind: LogTimeKind) => void;
	/** 名称下拉：「清除筛选」按钮被换掉以后焦点回到它。 */
	nameSelect: Ref<HTMLSelectElement>;
	/** 「只看失败」开关：只计数那一行里的「只看失败」被换掉以后焦点回到它。 */
	failedToggle: Ref<HTMLButtonElement>;
}) {
	const failed = filter.failed === true;
	const failures = failedTotal(summary);
	return (
		<div className="flex-none border-b border-border-soft">
			<fieldset
				aria-label={ACTION_PAGE.toolbar}
				className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 px-3 py-1.5"
			>
				<NativeSelect
					ref={nameSelect}
					aria-label={ACTION_PAGE.byName}
					value={filter.name ?? ""}
					onChange={(event) => onFilter(withName(filter, event.target.value || undefined))}
					className="w-48"
				>
					<NativeSelectOption value="">{ACTION_PAGE.allNames}</NativeSelectOption>
					{summary.names.map((n) => (
						<NativeSelectOption key={n.name} value={n.name}>
							{untrustedPlain(n.name)}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					ref={failedToggle}
					size="sm"
					aria-pressed={failed}
					onClick={() => onFilter(withFailed(filter, !failed))}
					className="aria-pressed:bg-raised-2 aria-pressed:text-fg-1 aria-pressed:shadow-[inset_0_0_0_1px_var(--border-strong)]"
				>
					<StatusDot kind="failed" />
					{ACTION_PAGE.failedOnly}
				</Button>
				<Segmented
					label={ACTION_PAGE.timeKind}
					value={timeKind}
					onChange={onTimeKind}
					options={TIME_OPTIONS}
					className="ml-auto"
				/>
			</fieldset>
			<div className="flex items-start gap-x-3 px-3 pb-1.5 text-xs text-fg-2">
				<p className="m-0 flex-none py-0.75">
					{ACTION_PAGE.total(
						formatInteger(actionCount(summary)),
						summary.marks > 0 ? formatInteger(summary.marks) : null,
					)}
				</p>
				<fieldset
					aria-label={ACTION_PAGE.nameCounts}
					className="m-0 flex max-h-14 min-w-0 flex-1 flex-wrap gap-x-1 gap-y-0.5 overflow-y-auto border-0 p-0"
				>
					{summary.names.map((n) => (
						<CountButton
							key={n.name}
							label={n.name}
							count={formatInteger(n.total)}
							pressed={filter.name === n.name}
							onClick={() => onFilter(withName(filter, n.name))}
						/>
					))}
					<CountButton
						label={ACTION_PAGE.failedCount(formatInteger(failures))}
						pressed={failed}
						danger
						onClick={() => onFilter(withFailed(filter, !failed))}
					/>
				</fieldset>
				{!summary.names_complete && summary.unlisted && (
					<p data-testid="unlisted-names" className="m-0 flex-none py-0.75 text-fg-3">
						{ACTION_PAGE.unlistedNames(
							formatInteger(summary.unlisted.total),
							formatInteger(summary.unlisted.failed),
						)}
					</p>
				)}
			</div>
		</div>
	);
}

/** 一个计数按钮：名称加个数（失败的只有一句，不分开写）。 */
function CountButton({
	label,
	count,
	pressed,
	danger = false,
	onClick,
}: {
	label: string;
	count?: string;
	pressed: boolean;
	danger?: boolean;
	onClick: () => void;
}) {
	const plain = untrustedPlain(label);
	const full = count === undefined ? plain : `${plain} ${count}`;
	return (
		<Truncate
			label={full}
			render={
				<button
					type="button"
					aria-pressed={pressed}
					aria-label={count === undefined ? undefined : full}
					onClick={onClick}
					className={cn(
						"inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-xs whitespace-nowrap transition-colors hover:bg-raised aria-pressed:border-border-strong aria-pressed:bg-raised-2",
						danger ? "text-danger-fg" : "text-fg-2",
					)}
				/>
			}
		>
			<Truncate untrusted>{label}</Truncate>
			{count !== undefined && <span className="flex-none font-mono text-fg-1">{count}</span>}
		</Truncate>
	);
}
