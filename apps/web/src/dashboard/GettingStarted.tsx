import type { DashboardSetup } from "@sfly/schema";
import { cn } from "cn";
import { BookOpenIcon, CheckIcon, CopyIcon, PlayIcon } from "lucide-react";
import { useConnectCommand } from "#/agents/connect-command";
import { useOverlays } from "#/components/app-shell/overlays";
import { DocPageLink } from "#/components/doc-page-link";
import { writeClipboard } from "#/components/feedback/clipboard";
import { notify } from "#/components/feedback/notify";
import { DashboardPanel, panelDocLink, panelLink } from "#/dashboard/DashboardPanel";
import { ACTION, DOC_PAGE, MESSAGE, PAGE, scenarioCreatedLabel } from "#/lib/copy";
import { Button } from "@/components/ui/button";

type StepId = keyof DashboardSetup;

/** 四步的顺序；白色主按钮属于第一个没完成的那一步。 */
const STEP_ORDER: readonly StepId[] = ["agent", "package", "scenario", "run"];

/** 第一个没完成的步骤；四步都完成时没有（控制台已经换成运行的内容）。 */
function nextStep(setup: DashboardSetup): StepId | undefined {
	return STEP_ORDER.find((id) => !setup[id].done);
}

interface Step {
	id: StepId;
	title: string;
	done: boolean;
	/** 完成后写在标题下面的事实。 */
	fact: string;
	/** 没完成时的说明。 */
	body: React.ReactNode;
	/** 没完成时的完成条件。 */
	doneWhen?: string;
	/** 没完成时右侧的一行状态。 */
	state: string;
	action: React.ReactNode;
}

const Mono = ({ children }: { children: React.ReactNode }) => (
	<span className="font-mono text-xs">{children}</span>
);

/**
 * 全新环境的控制台（外壳页方案第 5 节，原型 b-wall#empty）：还没有运行过任何场景时只显示这四步。
 * 白色主按钮属于第一个没完成的步骤，发布节点包那一步没有白色按钮（发布在命令行里完成）；
 * 出现第一个运行之后控制台不再渲染它。
 */
export function GettingStarted({ setup }: { setup: DashboardSetup }) {
	const overlays = useOverlays();
	const command = useConnectCommand();
	const next = nextStep(setup);
	const finished = STEP_ORDER.filter((id) => setup[id].done).length;
	const buttonVariant = (id: StepId) => (next === id ? ("primary" as const) : ("default" as const));
	const buttonSize = (id: StepId) => (next === id ? ("default" as const) : ("sm" as const));

	const steps: Step[] = [
		{
			id: "agent",
			title: "接入一台 Agent",
			done: setup.agent.done,
			fact:
				setup.agent.online > 1
					? `${setup.agent.name} 等 ${setup.agent.online} 台在线`
					: `${setup.agent.name} 在线`,
			body: (
				<>
					任务在 Agent 所在的测试机上执行。在测试机上运行这条命令，Agent 会主动连接控制面；开发机加{" "}
					<Mono>--dev</Mono> 同时装好 <Mono>sfly</Mono> 命令行。
					<code className="mt-2.5 block max-w-160 overflow-x-auto rounded-md border border-border bg-sunk px-3 py-2 font-mono text-xs whitespace-pre text-fg-1">
						{command}
					</code>
				</>
			),
			doneWhen: `完成：${PAGE.agents}页出现一台在线的 Agent。`,
			state: MESSAGE.noAgents,
			action: setup.agent.done ? (
				panelLink("/agents", PAGE.agents)
			) : (
				<Button
					variant="primary"
					onClick={() =>
						writeClipboard(
							command,
							() => notify.success(MESSAGE.copied),
							"可以手动选中上面的命令复制",
						)
					}
				>
					<CopyIcon />
					复制安装命令
				</Button>
			),
		},
		{
			id: "package",
			title: ACTION.publishPackage,
			done: setup.package.done,
			fact: setup.package.latest
				? setup.package.count > 1
					? `已发布 ${setup.package.count} 个节点包，最近是 ${setup.package.latest.name}@${setup.package.latest.version}`
					: `已发布 ${setup.package.latest.name}@${setup.package.latest.version}`
				: "",
			body: (
				<>
					在节点包项目里运行 <Mono>sfly publish</Mono>；只用标准节点时，上传 <Mono>sfly-std</Mono>{" "}
					的 <Mono>.sflypkg</Mono>。
				</>
			),
			doneWhen: `完成：${PAGE.packages}页出现至少一个版本。`,
			state: MESSAGE.noPackages,
			action: setup.package.done
				? panelLink("/packages", PAGE.packages)
				: panelDocLink("publish", `${PAGE.docs} · ${DOC_PAGE.publish}`),
		},
		{
			id: "scenario",
			title: "新建场景并编排",
			done: setup.scenario.done,
			fact:
				setup.scenario.name === null
					? ""
					: setup.scenario.count > 1
						? `已有 ${setup.scenario.count} 个场景，最近新建的是「${setup.scenario.name}」`
						: scenarioCreatedLabel(setup.scenario.name),
			body: "在画布上从入口节点开始把节点连成链，选默认 Agent，保存版本。",
			state: MESSAGE.noScenarios,
			action: setup.scenario.done ? (
				panelLink("/orchestrations", PAGE.scenarios)
			) : (
				<Button
					variant={buttonVariant("scenario")}
					size={buttonSize("scenario")}
					onClick={() => overlays.open("new-scenario")}
				>
					{ACTION.newScenario}
				</Button>
			),
		},
		{
			id: "run",
			title: "触发第一次运行",
			done: setup.run.done,
			fact: "已有运行",
			body: `在场景卡片或画布上点「${ACTION.run}」，填入口参数后触发。`,
			state: MESSAGE.noRuns,
			action: setup.run.done ? (
				panelLink("/runs", PAGE.runs)
			) : setup.scenario.done ? (
				<Button
					variant={buttonVariant("run")}
					size={buttonSize("run")}
					onClick={() => overlays.open("run-scenario")}
				>
					<PlayIcon />
					{ACTION.runScenario}
				</Button>
			) : null,
		},
	];

	return (
		<>
			<DashboardPanel
				title="开始使用"
				count={`${finished} / 4`}
				aside={panelDocLink(
					"quickstart",
					<>
						<BookOpenIcon />
						{DOC_PAGE.quickstart}
					</>,
				)}
			>
				<ol className="m-0 list-none p-0">
					{steps.map((step, index) => (
						<StepRow key={step.id} step={step} index={index + 1} next={next === step.id} />
					))}
				</ol>
			</DashboardPanel>
			<p className="mt-3 mb-0 text-xs text-fg-3">
				开发节点包可以交给 AI 编程助手：{PAGE.docs}
				<DocPageLink page="quickstart">「{DOC_PAGE.quickstart}」</DocPageLink>
				里有可以直接复制给它的提示词。
			</p>
		</>
	);
}

function StepRow({ step, index, next }: { step: Step; index: number; next: boolean }) {
	return (
		<li
			data-step={step.id}
			data-state={step.done ? "done" : next ? "next" : "todo"}
			aria-current={next ? "step" : undefined}
			className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-3.5 border-b border-border-soft p-4 last:border-0"
		>
			<span
				className={cn(
					"grid size-6 place-items-center rounded-full border-[1.5px] font-mono text-xs font-semibold",
					step.done
						? "border-ok-line bg-ok-soft text-ok"
						: next
							? "border-fg-1 text-fg-1"
							: "border-border-strong text-fg-2",
				)}
			>
				{step.done ? (
					<>
						<CheckIcon aria-hidden className="size-3.5" />
						<span className="sr-only">已完成</span>
					</>
				) : (
					index
				)}
			</span>
			<div className="min-w-0">
				<h3 className={cn("m-0 text-base font-semibold", !next && "text-fg-2")}>{step.title}</h3>
				{step.done ? (
					<p className="m-0 mt-0.5 text-fg-1">{step.fact}</p>
				) : (
					<>
						<p className="m-0 mt-0.5 text-fg-2">{step.body}</p>
						{step.doneWhen && <p className="m-0 mt-2 text-xs text-fg-3">{step.doneWhen}</p>}
					</>
				)}
			</div>
			<div className="flex flex-col items-end gap-2">
				{step.action}
				{!step.done && (
					<span className="pt-0.5 text-xs whitespace-nowrap text-fg-3">{step.state}</span>
				)}
			</div>
		</li>
	);
}
