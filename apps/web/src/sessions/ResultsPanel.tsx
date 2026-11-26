import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { MESSAGE, SESSION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { untrustedPlain } from "#/lib/untrusted-text";
import { useRunStatus } from "#/monitor/live-run";
import { runStatus } from "#/monitor/run-model";
import { Truncate } from "@/components/ui/truncate";
import {
	commitStat,
	type ResultCommit,
	type ResultRun,
	type ResultVersion,
	type SessionResults,
	shortCommit,
} from "./results";

/**
 * 会话页右侧的「成果」（#547）：这个会话留下了什么，三块——工作区的提交（第几轮、提交号前 7 位、改了几个文件、增删行数，展开看差异）、
 * 场景版本（场景名、版本号，链到版本历史）、运行（运行 ID 前几位、场景名、当前状态，链到运行监控）。
 * **全部来自这个会话的 `platform` 事件**（`results.ts`）：助手在对话里说的不进来，模型说「运行成功了」但没有真的触发，这里就没有它。
 * 运行的状态跟着运行变：用运行监控共用的那份缓存（`useRunStatus`），在跑的运行每 5 秒重新读一次，结束了就不再读。**不开运行事件流**：
 * 会话页有多少个运行就开多少条的话，五个在跑的运行就占满浏览器对同源的 6 条连接，页面自己的发送、停止、结束会话排不上队。
 * 场景名和会话里别的文字一样要当作别人写的：会话令牌能写场景（新建、改名、保存版本：`scenario` 的写入不限人），名字不再只是登录的人写的，所以走 `Truncate untrusted`，不原样显示。
 * 样式是最薄的一版（统一的样式在 #550）。
 */
export function ResultsPanel({
	results,
	partial,
}: {
	results: SessionResults;
	/** 更早的事件还没有读进来：它们里面的成果这里还没有。 */
	partial: boolean;
}) {
	return (
		<aside aria-label={SESSION.results.title} data-testid="session-results" className="min-w-0">
			<h2 className="m-0 mb-3 text-sm font-semibold text-fg-1">{SESSION.results.title}</h2>
			<div className="flex flex-col gap-4">
				<Block
					testId="results-commits"
					title={SESSION.results.commits}
					empty={SESSION.results.emptyCommits}
					count={results.commits.length}
				>
					{results.commits.map((commit) => (
						<CommitResult key={commit.seq} commit={commit} />
					))}
				</Block>
				<Block
					testId="results-versions"
					title={SESSION.results.versions}
					empty={SESSION.results.emptyVersions}
					count={results.versions.length}
				>
					{results.versions.map((version) => (
						<VersionResult key={version.seq} version={version} />
					))}
				</Block>
				<Block
					testId="results-runs"
					title={SESSION.results.runs}
					empty={SESSION.results.emptyRuns}
					count={results.runs.length}
				>
					{results.runs.map((run) => (
						<RunResult key={run.seq} run={run} />
					))}
				</Block>
			</div>
			{partial && (
				<p data-testid="results-partial" className="m-0 mt-3 text-xs text-fg-3">
					{SESSION.results.partial}
				</p>
			)}
		</aside>
	);
}

/** 一块：标题、个数，没有时写一句说明。 */
function Block({
	testId,
	title,
	empty,
	count,
	children,
}: {
	testId: string;
	title: string;
	empty: string;
	count: number;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} data-testid={testId} className="min-w-0">
			<h3
				id={headingId}
				className="m-0 mb-1.5 flex items-baseline gap-2 text-xs font-medium text-fg-2"
			>
				{title}
				{count > 0 && <span className="font-mono text-fg-3">{count}</span>}
			</h3>
			{count === 0 ? (
				<p data-testid={`${testId}-empty`} className="m-0 text-xs text-fg-3">
					{empty}
				</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-1.5 p-0">{children}</ul>
			)}
		</section>
	);
}

const ITEM = "min-w-0 rounded-md border border-border-soft bg-surface text-xs";

/** 一个提交：第几轮、提交号前 7 位、改了几个文件和增删行数；展开是文件列表和差异。 */
function CommitResult({ commit }: { commit: ResultCommit }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const stat = commitStat(commit.files);
	return (
		<li data-testid="result-commit" className={ITEM}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 pt-1.5">
				<span data-testid="result-commit-turn" className="text-fg-3">
					{SESSION.results.commitTurn(commit.turn)}
				</span>
				<span data-testid="result-commit-hash" title={commit.hash} className="font-mono text-fg-1">
					<span className="sr-only">{SESSION.results.hash} </span>
					{shortCommit(commit.hash)}
				</span>
			</div>
			<div data-testid="result-commit-stat" className="px-2.5 text-fg-2">
				{SESSION.results.commitStat(stat.files, stat.additions, stat.deletions)}
			</div>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-1 px-2.5 pt-0.5 pb-1.5 text-left text-fg-2 hover:text-fg-1"
			>
				<ChevronRightIcon
					aria-hidden
					className="size-3.5 flex-none transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
					style={{ rotate: open ? "90deg" : "0deg" }}
				/>
				{open ? SESSION.results.hideDiff : SESSION.results.showDiff}
			</button>
			{open && (
				<div id={bodyId} className="border-t border-border-soft bg-sunk">
					<ul
						aria-label={SESSION.results.files}
						data-testid="result-commit-files"
						className="m-0 flex list-none flex-col gap-0.5 px-2.5 py-1.5"
					>
						{commit.files.map((file) => (
							<li key={file.path} className="flex min-w-0 items-center gap-2 font-mono">
								<Truncate untrusted className="flex-1 text-fg-1">
									{file.path}
								</Truncate>
								{file.additions === null || file.deletions === null ? (
									<span className="flex-none text-fg-3">{SESSION.results.binary}</span>
								) : (
									<span className="flex flex-none gap-1.5">
										<span className="text-ok">{SESSION.results.additions(file.additions)}</span>
										<span className="text-danger-fg">
											{SESSION.results.deletions(file.deletions)}
										</span>
									</span>
								)}
							</li>
						))}
					</ul>
					<pre
						data-testid="result-commit-diff"
						className="m-0 max-h-72 overflow-auto border-t border-border-soft px-2.5 py-1.5 font-mono leading-5 whitespace-pre text-fg-2"
					>
						{commit.diff === "" ? (
							SESSION.results.noDiff
						) : (
							<UntrustedText text={commit.diff} mode="text" />
						)}
					</pre>
					{commit.truncated && (
						<p
							data-testid="result-commit-truncated"
							className="m-0 border-t border-border-soft px-2.5 py-1.5 text-fg-3"
						>
							{SESSION.results.truncated}
						</p>
					)}
				</div>
			)}
		</li>
	);
}

/** 一个场景版本：场景名、版本号，链到版本历史（打开那个版本）。场景名当作别人写的文字。 */
function VersionResult({ version }: { version: ResultVersion }) {
	return (
		<li data-testid="result-version" className={ITEM}>
			<Truncate
				label={`${untrustedPlain(version.name)} · v${version.version}`}
				render={
					<Link
						to="/orchestrations/$id/versions"
						params={{ id: version.scenarioId }}
						search={{ b: version.version }}
						aria-description={SESSION.record.openVersion}
						className="flex min-w-0 items-baseline gap-2 px-2.5 py-1.5 hover:bg-raised"
					/>
				}
			>
				<Truncate untrusted className="flex-1 text-fg-1">
					{version.name}
				</Truncate>
				<span className="flex-none font-mono text-fg-2">v{version.version}</span>
			</Truncate>
		</li>
	);
}

/** 一次运行：运行 ID 前几位、场景名（当作别人写的文字）、当前状态，链到运行监控。 */
function RunResult({ run }: { run: ResultRun }) {
	const live = useRunStatus(run.runId);
	const status = live.data ? runStatus(live.data) : null;
	return (
		<li data-testid="result-run" data-run={run.runId} className={ITEM}>
			<Truncate
				label={`${shortId(run.runId)} · ${untrustedPlain(run.scenarioName)}`}
				render={
					<Link
						to="/runs/$id"
						params={{ id: run.runId }}
						aria-description={SESSION.record.openRun}
						className="flex min-w-0 flex-col gap-0.5 px-2.5 py-1.5 hover:bg-raised"
					/>
				}
			>
				<span className="flex min-w-0 items-baseline gap-2">
					<span data-slot="run-id" className="flex-none font-mono text-fg-1">
						{shortId(run.runId)}
					</span>
					<Truncate untrusted className="flex-1 text-fg-2">
						{run.scenarioName}
					</Truncate>
				</span>
				<span data-testid="result-run-status" data-status={live.data?.status}>
					{status ? (
						<StatusPill kind={status.kind} pulse={status.kind === "running"}>
							{status.label}
						</StatusPill>
					) : live.isError ? (
						<span className="text-fg-3">{SESSION.results.runUnknown}</span>
					) : (
						<span className="text-fg-3">{MESSAGE.loading}</span>
					)}
				</span>
			</Truncate>
		</li>
	);
}
