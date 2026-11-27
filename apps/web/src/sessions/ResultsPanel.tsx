import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { INLINE_LINK } from "#/lib/inline-link";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Truncate } from "@/components/ui/truncate";
import {
	hasResults,
	newestFirst,
	type ResultCommit,
	type ResultScenario,
	resultScenarios,
	type SessionResults,
	versionsSearch,
} from "./results";
import { SessionRunCard } from "./SessionRunCard";
import { commitTotals, shortHash } from "./session-text";

/**
 * 会话页右侧的「成果」（#547，定稿 #551）：这个会话留下了什么，三块——场景（场景名、这个会话保存过的版本号，链到场景页和版本历史里
 * 这几个版本的对比）、运行（运行卡片，链到运行监控）、工作区的提交（第几轮、提交号前 7 位、改了几个文件、增删行数，展开看差异）。
 * **全部来自这个会话的 `platform` 事件**（`results.ts`）：助手在对话里说的不进来，模型说「运行成功了」但没有真的触发，这里就没有它。
 * 各块里最近的在前；没有内容的块不显示；整栏没有内容时写一句「助手对平台做的事会出现在这里」。
 * 运行卡片和时间线上内嵌的是同一个组件（`SessionRunCard`），状态读运行监控共用的那份缓存。**事件流名额是 2 个**（`live-runs.ts`）：第一次读到「在跑」的运行里
 * 最近的两个开运行事件流（没读到的先轮询）（时间线和成果栏里的同一个运行共用一条），由事件流推送、和运行监控同时变；其余的每 5 秒重新读，状态比运行监控晚最多 5 秒。
 * 为什么不都开：浏览器对同源的 6 条连接是整个浏览器共用的，会话的事件流 1 条、运行的 2 条、再有一个运行监控标签页 1 条，给页面的请求留 2 条。
 * 场景名和会话里别的文字一样要当作别人写的：会话令牌能写场景（新建、改名、保存版本），名字不再只是登录的人写的，所以走 `Truncate untrusted`。
 * 窄窗口时这一栏收到时间线下面（`SessionPage` 的版面）；以后再加一块（待批准的操作，#496）往这个列表里加，不为它画占位。
 */
export function ResultsPanel({
	results,
	partial,
}: {
	results: SessionResults;
	/** 更早的事件还没有读进来：它们里面的成果这里还没有。 */
	partial: boolean;
}) {
	const scenarios = resultScenarios(results);
	const runs = newestFirst(results.runs);
	const commits = newestFirst(results.commits);
	return (
		<aside aria-label={SESSION.results.title} data-testid="session-results" className="min-w-0">
			<h2 className="m-0 mb-3 text-sm font-semibold text-fg-1">{SESSION.results.title}</h2>
			{/* 更早的事件没读进来时不能说「还没有」：更早的成果在加载更早的内容后才列出，下面那一句说的是这个。 */}
			{!hasResults(results) && !partial && (
				<p data-testid="results-empty" className="m-0 text-xs text-fg-3">
					{SESSION.results.empty}
				</p>
			)}
			<div className="flex flex-col gap-4">
				{scenarios.length > 0 && (
					<Block
						testId="results-scenarios"
						title={SESSION.results.scenarios}
						count={scenarios.length}
					>
						{scenarios.map((scenario) => (
							<ScenarioResult key={scenario.scenarioId} scenario={scenario} />
						))}
					</Block>
				)}
				{runs.length > 0 && (
					<Block testId="results-runs" title={SESSION.results.runs} count={runs.length}>
						{runs.map((run) => (
							<li key={run.seq} data-testid="result-run" data-run={run.runId} className="min-w-0">
								<SessionRunCard runId={run.runId} scenarioName={run.scenarioName} />
							</li>
						))}
					</Block>
				)}
				{commits.length > 0 && (
					<Block testId="results-commits" title={SESSION.results.commits} count={commits.length}>
						{commits.map((commit) => (
							<CommitResult key={commit.seq} commit={commit} />
						))}
					</Block>
				)}
			</div>
			{partial && (
				<p data-testid="results-partial" className="m-0 mt-3 text-xs text-fg-3">
					{SESSION.results.partial}
				</p>
			)}
		</aside>
	);
}

/** 一块：标题、个数和清单（没有内容的块不画）。 */
function Block({
	testId,
	title,
	count,
	children,
}: {
	testId: string;
	title: string;
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
				<span className="font-mono text-fg-3">{count}</span>
			</h3>
			<ul className="m-0 flex list-none flex-col gap-1.5 p-0">{children}</ul>
		</section>
	);
}

const ITEM = "min-w-0 rounded-md border border-border-soft bg-surface text-xs";

/** 一个提交：第几轮、提交号前 7 位、改了几个文件和增删行数；展开是文件列表和差异。 */
function CommitResult({ commit }: { commit: ResultCommit }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const stat = commitTotals(commit.files);
	return (
		<li data-testid="result-commit" className={ITEM}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 pt-1.5">
				<span data-testid="result-commit-turn" className="text-fg-3">
					{SESSION.results.commitTurn(commit.turn)}
				</span>
				<span data-testid="result-commit-hash" title={commit.hash} className="font-mono text-fg-1">
					<span className="sr-only">{SESSION.commit.hash} </span>
					{shortHash(commit.hash)}
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
						aria-label={SESSION.commit.files}
						data-testid="result-commit-files"
						className="m-0 flex list-none flex-col gap-0.5 px-2.5 py-1.5"
					>
						{commit.files.map((file) => (
							<li key={file.path} className="flex min-w-0 items-center gap-2 font-mono">
								<Truncate untrusted className="flex-1 text-fg-1">
									{file.path}
								</Truncate>
								{file.additions === null || file.deletions === null ? (
									<span className="flex-none text-fg-3">{SESSION.commit.binary}</span>
								) : (
									<span className="flex flex-none gap-1.5">
										<span className="text-ok">{SESSION.commit.additions(file.additions)}</span>
										<span className="text-danger-fg">
											{SESSION.commit.deletions(file.deletions)}
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
							{SESSION.commit.truncated}
						</p>
					)}
				</div>
			)}
		</li>
	);
}

/**
 * 一个场景：场景名（链到场景页）和这个会话保存过的版本——每个版本号链到版本历史里的那个版本，保存过几个时再给一个对比最早和最晚的入口
 * （版本历史选中这几个版本）。场景名当作别人写的文字。
 */
function ScenarioResult({ scenario }: { scenario: ResultScenario }) {
	const label = untrustedPlain(scenario.name);
	return (
		<li data-testid="result-scenario" data-scenario={scenario.scenarioId} className={ITEM}>
			<Truncate
				label={label}
				render={
					<Link
						to="/orchestrations/$id"
						params={{ id: scenario.scenarioId }}
						aria-description={SESSION.results.openScenario}
						className="flex min-w-0 items-baseline px-2.5 pt-1.5 pb-1 hover:bg-raised"
					/>
				}
			>
				<Truncate untrusted className="flex-1 font-medium text-fg-1">
					{scenario.name}
				</Truncate>
			</Truncate>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 pb-1.5 text-fg-2">
				<span className="text-fg-3">{SESSION.results.versions}</span>
				{scenario.versions.map((version) => (
					<Link
						key={version}
						to="/orchestrations/$id/versions"
						params={{ id: scenario.scenarioId }}
						search={{ b: version }}
						data-testid="result-version"
						title={SESSION.results.openVersion(version)}
						className={`${INLINE_LINK} font-mono`}
					>
						v{version}
					</Link>
				))}
				{scenario.versions.length > 1 && (
					<Link
						to="/orchestrations/$id/versions"
						params={{ id: scenario.scenarioId }}
						search={versionsSearch(scenario.versions)}
						data-testid="result-compare"
						className={INLINE_LINK}
					>
						{SESSION.results.compareVersions(
							Math.min(...scenario.versions),
							Math.max(...scenario.versions),
						)}
					</Link>
				)}
			</div>
		</li>
	);
}
