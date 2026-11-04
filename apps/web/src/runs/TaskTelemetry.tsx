import { useLayoutEffect, useRef, useState } from "react";
import { Section } from "#/canvas/Inspector";
import type { AttemptView } from "./api";
import { statusTone } from "./format";
import {
	type LogLine,
	progressLong,
	progressPercent,
	TAIL_LIMIT,
	type TaskProgress,
	useTaskLogs,
} from "./logs";

const LEVEL_LABEL: Record<LogLine["level"], string> = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERR  ",
};

const time = (iso: string) => {
	const d = new Date(iso);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

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
 * 节点详情里的进度与实时日志（#10）：默认看最近一次尝试，有多次尝试时可以切换。
 * 日志尾部通过 SSE 实时追加；滚动条在底部时自动跟随新行。
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
			<LogTail key={attempt.task_id} taskId={attempt.task_id} live={live} />
		</>
	);
}

function LogTail({ taskId, live }: { taskId: string; live: boolean }) {
	const { lines, loaded } = useTaskLogs(taskId);
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);

	// 新行到达时：之前停在底部就继续跟随，否则保持用户的滚动位置。
	useLayoutEffect(() => {
		const el = box.current;
		if (el && follow.current && lines.length > 0) el.scrollTop = el.scrollHeight;
	}, [lines]);

	const aside = !loaded
		? "加载中…"
		: `${lines.length >= TAIL_LIMIT ? `最近 ${TAIL_LIMIT}` : lines.length} 行${live ? " · 实时" : ""}`;
	return (
		<Section title="日志" aside={aside}>
			{loaded && lines.length === 0 ? (
				<p className="sf-hint">{live ? "还没有日志输出。" : "这次尝试没有日志输出。"}</p>
			) : (
				<div
					ref={box}
					className="sf-log"
					role="log"
					aria-live="off"
					onScroll={(e) => {
						const el = e.currentTarget;
						follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
					}}
				>
					{lines.map((line) => (
						<div key={line.seq} data-level={line.level} data-source={line.source}>
							<span className="sf-log__t">{time(line.time)}</span>{" "}
							<span className="sf-log__lv">{LEVEL_LABEL[line.level]}</span>{" "}
							{line.source !== "stdout" && <span className="sf-log__src">{line.source}</span>}
							<span className="sf-log__msg">{line.text}</span>
						</div>
					))}
				</div>
			)}
		</Section>
	);
}
