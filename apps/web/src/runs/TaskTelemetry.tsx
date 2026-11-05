import { useState } from "react";
import { Section } from "#/canvas/Inspector";
import { TaskArtifacts } from "./Artifacts";
import type { AttemptView } from "./api";
import { statusTone } from "./format";
import { LogViewer } from "./LogViewer";
import { progressLong, progressPercent, type TaskProgress } from "./logs";

/** 进度条 + 文字（节点详情）。 */
export function ProgressBar({ progress, live }: { progress: TaskProgress; live: boolean }) {
	const percent = progressPercent(progress);
	return (
		<div className="sf-progress" data-live={live}>
			<div
				className="sf-progress__track"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={progress.total ?? undefined}
				aria-valuenow={progress.current}
				aria-label="任务进度"
			>
				<i style={{ width: `${percent ?? 100}%` }} data-indeterminate={percent === null} />
			</div>
			<div className="sf-progress__text">
				<span>{progressLong(progress)}</span>
				{percent !== null && <b>{Math.floor(percent)}%</b>}
			</div>
		</div>
	);
}

/**
 * 节点详情里的进度、日志与产物（#10、#18）：默认看最近一次尝试，有多次尝试时可以切换。
 * 日志先加载最后一页历史再接上实时流，虚拟滚动，可以往前翻页、筛选、下载（LogViewer）。
 */
export function TaskTelemetry({ attempts }: { attempts: AttemptView[] }) {
	// 内置节点没有 Agent，也没有日志。
	const tasks = attempts.filter((a) => a.agent !== null);
	const [picked, setPicked] = useState<string | null>(null);
	const latest = tasks.at(-1);
	const attempt = tasks.find((a) => a.task_id === picked) ?? latest;
	if (!attempt) return null;
	const live = statusTone(attempt.status) === "current";
	return (
		<>
			{tasks.length > 1 && (
				<Section title="查看尝试">
					<fieldset className="sf-seg" aria-label="查看第几次尝试的日志">
						{tasks.map((a) => (
							<button
								key={a.task_id}
								type="button"
								aria-pressed={a.task_id === attempt.task_id}
								onClick={() => setPicked(a.task_id === latest?.task_id ? null : a.task_id)}
							>
								第 {a.attempt} 次
							</button>
						))}
					</fieldset>
				</Section>
			)}
			{attempt.progress && (
				<Section title="进度" aside={live ? "实时" : "最后一次上报"}>
					<ProgressBar progress={attempt.progress} live={live} />
				</Section>
			)}
			<LogViewer key={attempt.task_id} taskId={attempt.task_id} live={live} />
			<TaskArtifacts taskId={attempt.task_id} status={attempt.status} />
		</>
	);
}
