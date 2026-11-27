// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 清单里的表达式是源码里的原文（含 `${…}` 的模板字符串），不是想写模板
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 别人写的文字（Agent 报的、节点写的、节点包的元信息、助手写的话）只经 UntrustedText、Truncate 的 untrusted、untrustedPlain 显示（#699，
// docs/DESIGN-SYSTEM.md「不可信的文字」）。这份清单是「控制台里哪些地方显示这类文字」的完整记录，也是 PR 里列的那张表的来源：
// 每个文件里要经过的表达式（`<UntrustedText text={…}>` 的 `text`、`untrustedPlain(…)` 的参数）和 `Truncate untrusted` 的个数。
// 检查：① 清单里的每一处都还在（有人把包装去掉、或者把组件换成裸的文字，这里红）；② 用了这套办法的文件都在清单里
// （新加显示这类文字的地方，要把它记在这里）。页面上实际有没有原样留下的有害字符，由 e2e `untrusted-text.spec.ts` 逐个区域查。

interface Entry {
	/** 这个文件里经过组件的表达式（出现几次写几次）。 */
	wrapped?: string[];
	/** `<Truncate untrusted>` 的个数。 */
	truncate?: number;
}

const INVENTORY: { area: string; files: Record<string, Entry> }[] = [
	{
		area: "Agent 的名称、版本、系统、地址、更新和安装的原因、预检消息、「经 X」",
		files: {
			"agents/AgentRack.tsx": {
				wrapped: [
					"agent.name",
					"update.detail",
					"`${agent.install.package}@${agent.install.version}`",
					"unavailable",
					"`${agent.install.package}@${agent.install.version}`",
					'agent.info.agent_version || "—"',
					'`${agent.info.os || "?"}/${agent.info.arch || "?"}`',
					'endpointLabel(agent.endpoint) || "—"',
					"item",
				],
			},
			"agents/UpdateNowButton.tsx": { wrapped: ["agent.name", "agent.name"] },
			"agents/AgentAdminActions.tsx": {
				wrapped: ["agent.name", "agent.name", "agent.name", "agent.name"],
			},
			"agents/credentials/CredentialsDialog.tsx": {
				wrapped: ["name", "name", "name"],
				truncate: 1,
			},
			"dashboard/AgentsPanel.tsx": { wrapped: ["agent.name", 'agent.info.agent_version || "—"'] },
			"dashboard/GettingStarted.tsx": { wrapped: ["step.fact"] },
			"editor/inspector/AgentSelect.tsx": { wrapped: ["a.name", "value"] },
			"routes/_shell/orchestrations/index.tsx": { wrapped: ["a.name"] },
			"scenarios/ScenarioList.tsx": { wrapped: ["a.name", "a.name"] },
			"run-drawer/TriggerForm.tsx": { wrapped: ["row.title", "row.detail", "p.message"] },
			"components/via-tag.tsx": { wrapped: ["viaLabel(via)"], truncate: 1 },
			"monitor/QueueWaitNote.tsx": {
				wrapped: ["wait.agent", "holder.orchestration_name", "holderNodeLabel(holder)"],
			},
		},
	},
	{
		area: "失败原因和出错位置（运行详情、概览、顶栏、控制台、画布）",
		files: {
			"monitor/FailureArea.tsx": {
				wrapped: [
					"first.message",
					"first.location",
					"fullText",
					"`${FAILURE_AREA.title.running}：${failureSummary(first)}`",
				],
			},
			"monitor/MonitorTopBar.tsx": { wrapped: ["failure.message", "failureSummary(failure)"] },
			"monitor/MonitorPage.tsx": { truncate: 1 },
			"dashboard/EndedPanel.tsx": {
				wrapped: ["failure.error.kind", "errorHeadline(failure.error.message)"],
			},
			"routes/_shell/feishu-bots.tsx": {
				wrapped: ["delivery.message", "result.message", "result.message", "result.next_step"],
			},
		},
	},
	{
		area: "进度说明和正在做的动作",
		files: {
			"monitor/Overview.tsx": {
				wrapped: ["activeDetail({ ...attempt, status: node.status }, now)"],
				truncate: 2,
			},
			"dashboard/RunBlock.tsx": { wrapped: ["activeDetail(node, now)"] },
			"agents/TaskSlot.tsx": { truncate: 2 },
			"components/slot-cell.tsx": { wrapped: ["summary"], truncate: 1 },
			"components/canvas/ActivityLine.tsx": {
				wrapped: [
					'activity.kind === "action" ? activity.name : activity.message',
					"activityLabel(activity)",
				],
			},
			"run-drawer/RunSummary.tsx": {
				wrapped: [
					"text",
					'[node.agent, since ? formatElapsed(now - Date.parse(since)) : null] .filter(Boolean) .join(" · ")',
					"progress.message",
					"logs.error",
					"line.text",
				],
			},
			"editor/run-state/RunState.tsx": {
				wrapped: [
					"withoutErrorClass(reason) || NODE_STATUS.failed.label",
					"withoutErrorClass(reason)",
					"nodeCardText(node, info).title",
					"view.agent",
					"activity.message",
					"view.error.kind",
					"errorHeadline(view.error.message)",
					"view.error.location",
					"reason",
					"reason",
					'state.error.message, "text"',
				],
			},
			"monitor/Attention.tsx": {
				wrapped: [
					"item.title",
					"readingValue(item)",
					"why",
					"logs.error",
					"line.text",
					"`${item.title}，${anomalyText(item, focus.generated_at)}`",
				],
			},
		},
	},
	{
		area: "动作的名称、字段和原因",
		files: {
			"actions/ActionTable.tsx": {
				wrapped: ["countOnlyText(row, timeKind, format.periodTime)", "outcome.reason"],
				truncate: 2,
			},
			"actions/ActionToolbar.tsx": { wrapped: ["n.name", "label"], truncate: 1 },
			"actions/InspectorActions.tsx": { wrapped: ["reason", "c.name"], truncate: 3 },
			"monitor/ActionTracks.tsx": { wrapped: ["b.item.name", "item.name", "n", "c.name"] },
		},
	},
	{
		area: "日志、任务的输入输出、产物的名称",
		files: {
			"monitor/LogList.tsx": { wrapped: ["line.text"] },
			"monitor/BottomPanel.tsx": {
				wrapped: [
					"logs.error",
					'a.agent ?? "控制面"',
					"ERROR_KIND_LABEL[a.error.kind] ?? a.error.kind",
					"a.error.kind",
					'error.message || "（没有错误信息）"',
					"a.error.location",
					"error.stack",
					"m[0]",
					"m[0]",
					"a.name",
					"a.error.kind",
					"a.name",
				],
			},
		},
	},
	{
		area: "节点包和节点类型的元信息",
		files: {
			"routes/_shell/packages.tsx": {
				wrapped: [
					"pkg.name",
					"latest.version",
					"pkg.name",
					"current.version",
					"v.version",
					"name",
					"name",
					"description",
					"node.name",
					"node.title",
					"summary",
					"pkg.name",
				],
			},
			"editor/AddNodeMenu.tsx": {
				wrapped: ["`${g.name} @${g.version}`", "item.title", "summary", "item.title", "detail"],
			},
			"components/canvas/NodeCard.tsx": {
				wrapped: [
					"tag.text",
					"title",
					"shownSlot.text",
					"shownCaption",
					"title",
					"caption",
					"title",
					"nodeDefaultTitle(node, info)",
				],
			},
			"editor/inspector/Inspector.tsx": {
				wrapped: [
					"w.message",
					"nodeCardText(node, info).title",
					"`${node.package}/${node.node}`",
					'`@${version ?? "未锁定"}`',
					"fieldLabel(node, e.field)",
					"paragraph",
					"`${node.package}/${node.node}`",
					"fieldLabel(node, e.field)",
					"nodeDefaultTitle(node, info)",
				],
			},
			"editor/OutlinePanel.tsx": { wrapped: ["n.title"], truncate: 1 },
			"editor/inspector/NodeOutputs.tsx": { wrapped: ["name", "description"] },
			"editor/inspector/node-forms.tsx": {
				wrapped: [
					"formNote",
					"name",
					"name",
					"problem",
					"name",
					'problems.join("；")',
					'problems.join("；")',
					"latest",
					'defaultAgent ?? "未设置"',
					"name",
					"v",
					"locked",
				],
			},
			"editor/inspector/value-fields.tsx": {
				wrapped: ["m", "name", "JSON.stringify(schema.default)", "JSON.stringify(c)"],
			},
			"editor/inspector/fields.tsx": { wrapped: ["type", "help", "text"] },
			"editor/inspector/ReferenceList.tsx": {
				wrapped: [
					"c.expression",
					"c.detail",
					"c.description",
					"c.expression",
					'c.description, "text"',
				],
			},
			"editor/NodeMenu.tsx": { wrapped: ["key", "text"] },
		},
	},
	{
		area: "指标、图表和关注项的名称（节点声明、SDK 上报）",
		files: {
			"metrics/MetricDeclarations.tsx": {
				wrapped: [
					"m.name",
					"m.unit",
					"m.name",
					'm.labels.join(" · ")',
					"info.primary_metric",
					"c.title",
					"m.name",
					"m.unit",
					"m.description",
					"c.title",
					'c.metrics.join(" · ")',
					"m.name",
					"m.description",
					'c.metrics.join("、")',
				],
			},
			"metrics/PrimaryMetric.tsx": {
				wrapped: ["name", "unit", "name", "unit", "name", "unit", "name", "name"],
			},
			"monitor/MetricChart.tsx": {
				wrapped: ["title", "unit", "unit", "l.name", "line.name", "title"],
			},
			"monitor/ChartWorkspace.tsx": {
				wrapped: [
					"title",
					'node.agent ?? ""',
					"`${entry.package}/${entry.node}@${entry.version}`",
					'node.agent ?? "—"',
					"progress.message",
					"node.error.kind",
					"errorHeadline(node.error.message)",
					"node.error.location",
					"node.error.location",
				],
			},
			"editor/run-state/NodeCharts.tsx": {
				wrapped: [
					"FOCUS.chartMissing(row.title)",
					"children",
					"chart.title",
					"readingValue(value)",
				],
			},
			"focus/FocusChart.tsx": { wrapped: ["item.title", "FOCUS.chartMissing(item.chart)"] },
			"focus/FocusList.tsx": {
				wrapped: [
					"edit.summary",
					"removed.name",
					"reason",
					"focusName(item)",
					"announcement",
					"item.chart",
				],
				truncate: 1,
			},
			"focus/FocusPlot.tsx": { wrapped: ["focusSeriesName({ metrics }, s)", "label"] },
			"focus/FocusReadout.tsx": { wrapped: ["item.title", "FOCUS.chartMissing(item.chart)"] },
			"focus/FocusRows.tsx": { wrapped: ["children", "item.unit"], truncate: 1 },
			"focus/FocusToggle.tsx": { wrapped: ["chart"] },
			"focus/FocusValue.tsx": { wrapped: ["series", "item.unit"] },
			"focus/focus-format.ts": {
				wrapped: ["nameOf(item)", "item.title", "item.chart", "readingValue(item)"],
			},
		},
	},
	{
		area: "助手会话（模型和工具写的话、会话标题、就绪状态、成果里的文件路径、差异和场景名、「经 会话」的标题）",
		files: {
			"sessions/SessionTimeline.tsx": {
				wrapped: [
					"item.by",
					"item.message",
					"turnEndText(item)",
					"turnEndText(item)",
					"item.author",
					"item.text",
				],
			},
			// 助手的话（Markdown）：每个文字节点、代码块、图片的说明经组件；链接的地址和主机名放进属性和提示里，用 `untrustedPlain`。
			"sessions/AssistantMarkdown.tsx": {
				wrapped: ["children", "alt", "text", "text", 'href ?? ""', "host"],
			},
			// 工具行：命令（标题）经截断层；展开后的命令、实时输出、结果正文是多行的正文。
			"sessions/ToolRow.tsx": {
				wrapped: ["line", "text", "text", 'line, "text"'],
				truncate: 1,
			},
			// 差异（提交的和编辑的）：每一行连同换行经组件。
			"sessions/DiffBlock.tsx": {
				wrapped: ['index < last - 1 || lines.at(-1) === "" ? `${line}\\n` : line'],
			},
			// 提交的记录（#546）：文件的路径经截断层（`Truncate untrusted`），差异经 `DiffBlock`。
			"sessions/CommitRow.tsx": { truncate: 1 },
			// 成果：提交里的文件路径和差异是模型写的东西；场景名会话令牌能写（新建、改名、保存版本），也不当作登录的人写的名字（版本号、运行 ID 不是）。
			"sessions/RecordRow.tsx": { truncate: 1 },
			// 成果栏的场景名（版本链接的提示用 `untrustedPlain`）和提交里的文件路径；运行卡片里的场景名、失败的节点和原因（#551）。
			"sessions/ResultsPanel.tsx": { wrapped: ["commit.diff", "scenario.name"], truncate: 2 },
			"sessions/SessionRunCard.tsx": { wrapped: ["scenarioName", "failure"], truncate: 2 },
			"sessions/ReadinessLine.tsx": {
				wrapped: ["SESSION.ready(readiness.workbench)", "item.what"],
			},
			"sessions/SessionList.tsx": { wrapped: ["session.created_by"], truncate: 1 },
			"sessions/SessionPage.tsx": {
				wrapped: ["waitingFor.title", "waitingFor.created_by", "next"],
			},
			"components/page.tsx": { wrapped: ["title"] },
		},
	},
	{
		area: "接口的错误信息（弹窗的 FormAlert、加载失败的 ErrorState）、编辑器的检查警告、卡片的警告徽标、引用选择器、版本对比、飞书机器人的删除对话框、图表标题的读屏名称",
		files: {
			"components/canvas/CardFocus.tsx": { wrapped: ["item.chart"] },
			"components/canvas/WarningBadge.tsx": { wrapped: ["w.message"] },
			"components/feedback/states.tsx": { wrapped: ["message", "errorSummary(error)"] },
			"components/ui/form-field.tsx": { wrapped: ["child"] },
			"editor/inspector/ReferencePicker.tsx": { wrapped: ["value", "value"] },
			"editor/inspector/ZoomEditor.tsx": { wrapped: ["name"] },
			"feishu-bots/dialogs.tsx": { wrapped: ["reference.input"] },
			"versions/DocumentDiffView.tsx": { wrapped: ["text", "tail", "tail"] },
		},
	},
];

const SRC = join(import.meta.dirname, "..");
// 这几个文件本身是这套办法的实现，不在清单里。
const IMPLEMENTATION = new Set([
	"components/untrusted-text.tsx",
	"components/ui/truncate.tsx",
	"components/feedback/error-message.tsx",
	"lib/untrusted-text.ts",
]);

/** 配对的括号里的内容（`s[from]` 是紧跟在开括号后面的第一个字符）；跳过引号里的。 */
function balanced(s: string, from: number, open: string, close: string): string {
	let depth = 1;
	let quote: string | undefined;
	let i = from;
	for (; i < s.length && depth > 0; i++) {
		const c = s[i] as string;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = undefined;
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === open) depth++;
		else if (c === close) depth--;
	}
	return s.slice(from, i - 1);
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** 一个源文件里经过组件的表达式和 Truncate untrusted 的个数。 */
function sitesIn(source: string): { wrapped: string[]; truncate: number } {
	const wrapped: string[] = [];
	for (const m of source.matchAll(/<UntrustedText\b/g)) {
		const end = source.indexOf("/>", m.index + m[0].length);
		const tag = source.slice(m.index + m[0].length, end);
		const prop = /\btext=\{/.exec(tag);
		if (prop)
			wrapped.push(
				squash(balanced(source, m.index + m[0].length + prop.index + prop[0].length, "{", "}")),
			);
	}
	for (const m of source.matchAll(/untrustedPlain\(/g)) {
		wrapped.push(squash(balanced(source, m.index + m[0].length, "(", ")")));
	}
	const truncate = [...source.matchAll(/<Truncate\b[^>]*?\buntrusted\b/gs)].length;
	return { wrapped, truncate };
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

const counted = (items: string[]) => {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
	return counts;
};

describe("别人写的文字经 UntrustedText 显示：清单", () => {
	for (const { area, files } of INVENTORY) {
		describe(area, () => {
			for (const [file, entry] of Object.entries(files)) {
				it(file, () => {
					const found = sitesIn(readFileSync(join(SRC, file), "utf8"));
					const have = counted(found.wrapped);
					for (const [expression, times] of counted(entry.wrapped ?? [])) {
						expect(
							have.get(expression) ?? 0,
							`${file}：「${expression}」应经过组件（${times} 处），现在 ${have.get(expression) ?? 0} 处`,
						).toBeGreaterThanOrEqual(times);
					}
					expect(found.truncate, `${file}：Truncate untrusted 的个数`).toBeGreaterThanOrEqual(
						entry.truncate ?? 0,
					);
				});
			}
		});
	}

	it("用了这套办法的文件都在清单里（新加显示这类文字的地方要记在清单里）", () => {
		const listed = new Set(INVENTORY.flatMap(({ files }) => Object.keys(files)));
		const unlisted = sourceFiles(SRC)
			.map((path) => relative(SRC, path))
			.filter((file) => !IMPLEMENTATION.has(file) && !listed.has(file))
			.filter((file) => {
				const found = sitesIn(readFileSync(join(SRC, file), "utf8"));
				return found.wrapped.length > 0 || found.truncate > 0;
			});
		expect(
			unlisted,
			"这些文件用了 UntrustedText / untrustedPlain / Truncate untrusted，请记进清单",
		).toEqual([]);
	});

	it("接口的错误信息写在页面上一律经组件：JSX 里没有裸的 `{…error.message}`（弹窗里的错误用 FormAlert、通知用 notify，它们自己处理字符串）", () => {
		// 控制面拼出来的句子里常嵌着 Agent 报的原文（Agent 名、更新失败的原因），不逐条判断哪一条里有别人的文字。
		// 只查最常见的写法（`{query.error.message}`、`{error.message}`）；别的写法（先赋给变量再显示）发现不了，新写的地方用 `ErrorMessage`。
		const raw = /\{[^{}]*\b(?:error|err)\??\.message\s*\}/;
		const offenders = sourceFiles(SRC)
			.map((path) => relative(SRC, path))
			.filter((file) => file !== "components/feedback/error-message.tsx")
			.flatMap((file) =>
				readFileSync(join(SRC, file), "utf8")
					.split("\n")
					.flatMap((line, index) =>
						// 通知的 `description:` 里是字符串，`notify` 自己处理；注释里写的例子不算。
						raw.test(line) && !/description:|^\s*(?:\*|\/\/)/.test(line)
							? [`${file}:${index + 1}`]
							: [],
					),
			);
		expect(offenders, "页面上显示的错误信息请用 <ErrorMessage error={…} />").toEqual([]);
	});

	it("清单里的文件都存在", () => {
		for (const { files } of INVENTORY) {
			for (const file of Object.keys(files)) {
				expect(() => readFileSync(join(SRC, file), "utf8"), file).not.toThrow();
			}
		}
	});
});
