import {
	agentInputs,
	feishuBotInputs,
	InvalidReferenceError,
	notifyBotValue,
	referencedAgents,
	referencesIn,
	resolveInputs,
} from "@sfly/orchestration";
import type { OrchestrationDocument, PackageMetadata } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents } from "../db/schema.js";
import { agentFor, type ChainPlan, planRun, type RunPlan } from "../engine/chain.js";
import { type AgentReference, checkReferencedAgents } from "../engine/referenced-agents.js";
import { type BotToCheck, checkFeishuBots } from "../feishu/bot-checks.js";
import { checkDocument } from "../orchestrations/document-checks.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { controlPlaneAgentProblem } from "../packages/requires-agent.js";
import { controlPlaneSdkProblem } from "../packages/requires-sdk.js";

/**
 * 不能触发的一个原因；code 与保存时的警告一致（含「Agent」类型的输入选的 Agent 没有注册过的
 * `agent_input_not_registered`，飞书通知节点和「飞书机器人」类型的输入选的机器人没有登记的
 * `feishu_bot_not_registered`，飞书通知节点的机器人写了不支持的引用的 `feishu_bot_reference_unsupported`），另有 `agent_not_registered`、`not_supported`、`sdk_version_unsatisfied`、
 * `agent_version_unsatisfied`。
 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

export type Preflight = (doc: OrchestrationDocument) => Promise<PreflightProblem[]>;

/** 文档锁定的节点包版本的元信息（包名 → 元信息；控制面没有这个版本的不在里面）。每个包查一次。 */
async function lockedPackages(
	doc: OrchestrationDocument,
	packages: PackageRepository,
): Promise<Map<string, PackageMetadata>> {
	const found = await Promise.all(
		Object.entries(doc.packages).map(
			async ([name, version]) => [name, await packages.getVersion(name, version)] as const,
		),
	);
	return new Map(
		found.flatMap(([name, published]) => (published ? [[name, published.metadata] as const] : [])),
	);
}

/**
 * 触发前的预检（docs/SEMANTICS.md §6）：结构、包版本锁定、引用、输入的静态检查全部通过
 * （「Agent」类型的输入的常量是已注册的 Agent，飞书通知节点和「飞书机器人」类型的输入的常量是已登记的机器人），
 * 包节点派发到的 Agent 都已注册（不要求在线），
 * 且控制面版本满足节点包需要的 SDK 版本（#79），节点所在的 Agent 和「Agent」类型的输入引用的 Agent 满足
 * 节点包需要的 Agent 版本（ADR 0019，见 requires-agent.ts）。
 * 返回全部不能触发的原因，空数组表示可以触发。未保存的草稿只存在于浏览器，由画布在触发前检查。
 *
 * 比较的是控制面版本 `version` 而不是 Agent 记录里的版本：只给与控制面版本一致的 Agent 派任务（ADR 0014），
 * 记录里版本不同的 Agent 会先自更新到这个版本，所以 Agent 执行任务时的 SDK 版本就是控制面版本；提示也如实这样写。
 */
export function createPreflight(deps: {
	db: Db;
	packages: PackageRepository;
	version: string;
}): Preflight {
	return async (doc) => {
		const problems: PreflightProblem[] = (await checkDocument(doc, deps)).map((w) => ({
			code: w.code,
			message: w.message,
			...(w.node_id ? { node_id: w.node_id } : {}),
		}));

		const wanted = new Map<string, string>();
		for (const node of doc.nodes) {
			if (node.kind !== "package") continue;
			const agent = agentFor(doc, node);
			if (agent) wanted.set(node.id, agent);
		}
		const names = [...new Set(wanted.values())];
		const registered = new Set(
			names.length
				? (
						await deps.db
							.select({ name: agents.name })
							.from(agents)
							.where(inArray(agents.name, names))
					).map((r) => r.name)
				: [],
		);
		for (const [nodeId, agent] of wanted) {
			if (registered.has(agent)) continue;
			problems.push({
				code: "agent_not_registered",
				message: `节点 ${nodeId} 派发到的 Agent ${agent} 还没有注册过`,
				node_id: nodeId,
			});
		}

		const locked = await lockedPackages(doc, deps.packages);
		// 「Agent」类型的输入的常量；引用入口参数的在触发时按实际值检查（createParamsCheck）。
		const constants: AgentReference[] = [];
		for (const node of doc.nodes) {
			if (node.kind !== "package" || !wanted.has(node.id)) continue;
			const metadata = locked.get(node.package);
			if (!metadata) continue;
			const pkg = { name: node.package, version: doc.packages[node.package] ?? "" };
			const sdk = controlPlaneSdkProblem(metadata, pkg, deps.version);
			if (sdk) {
				problems.push({
					code: "sdk_version_unsatisfied",
					message: `节点 ${node.id}：${sdk}`,
					node_id: node.id,
				});
			}
			const own = controlPlaneAgentProblem(metadata, pkg, wanted.get(node.id) ?? "", deps.version);
			if (own) {
				problems.push({
					code: "agent_version_unsatisfied",
					message: `节点 ${node.id}：${own}`,
					node_id: node.id,
				});
			}
			const type = metadata.nodes.find((n) => n.name === node.node);
			if (!type || metadata.requires_agent === undefined) continue;
			for (const { input, agent } of referencedAgents(type.inputs, node.inputs)) {
				if (referencesIn(agent).length > 0) continue;
				constants.push({ nodeId: node.id, input, agent, requirement: { metadata, pkg } });
			}
		}
		// 没有注册过的常量已经由静态检查（agent_input_not_registered）指出，这里只看版本。
		const referenced = await checkReferencedAgents(deps.db, constants);
		problems.push(...referenced.problems.filter((p) => p.code === "agent_version_unsatisfied"));

		// 执行计划的检查（单链、节点种类受支持、调度目标等）。
		if (problems.length === 0) {
			const plan = planRun(doc);
			if ("errors" in plan) {
				for (const message of plan.errors) problems.push({ code: "not_supported", message });
			}
		}
		return problems;
	};
}

/** 触发时按入口参数的实际值做的检查（{@link createParamsCheck}）。 */
export type ParamsCheck = (
	doc: OrchestrationDocument,
	plan: RunPlan,
	params: Record<string, unknown>,
) => Promise<PreflightProblem[]>;

/**
 * 触发时按入口参数的实际值检查：「Agent」类型的输入引用入口参数时，取到的 Agent 必须已注册（不要求在线），
 * 版本满足节点包需要的 Agent 版本（`requires_agent`，{@link checkReferencedAgents}）；
 * 飞书通知节点和「飞书机器人」类型的输入引用入口参数的机器人，取到的必须是已登记的飞书机器人（{@link checkFeishuBots}）。
 * 主链和子流程都检查（{@link knownParams}）；引用了前面节点输出的值要到派发时才知道，这里跳过
 * （飞书通知节点在执行时再看一次，机器人不存在时不发送、节点照常成功）。
 */
export function createParamsCheck(deps: { db: Db; packages: PackageRepository }): ParamsCheck {
	return async (doc, plan, params) => {
		const locked = await lockedPackages(doc, deps.packages);
		const wanted: AgentReference[] = [];
		const bots: BotToCheck[] = [];
		for (const { chain, params: known, source } of knownParams(plan, params)) {
			for (const node of chain.nodes) {
				// 整值引用入口参数的才在这里按实际值查；其他写法的引用已经由静态检查（feishu_bot_reference_unsupported）阻断。
				if (node.kind === "feishu_notify" && node.bot !== undefined) {
					const bot =
						notifyBotValue(node.bot).kind === "param" ? resolved(node.bot, known) : undefined;
					if (typeof bot === "string" && bot !== "") bots.push({ nodeId: node.id, bot, source });
				}
				if (node.kind !== "package") continue;
				const metadata = locked.get(node.package);
				const type = metadata?.nodes.find((n) => n.name === node.node);
				if (!metadata || !type) continue;
				const requirement = {
					metadata,
					pkg: { name: node.package, version: doc.packages[node.package] ?? "" },
				};
				for (const input of agentInputs(type.inputs)) {
					const value = node.inputs[input];
					if (typeof value !== "string" || referencesIn(value).length === 0) continue;
					const agent = resolved(value, known);
					if (typeof agent === "string" && agent !== "")
						wanted.push({ nodeId: node.id, input, agent, requirement, source });
				}
				for (const input of feishuBotInputs(type.inputs)) {
					const value = node.inputs[input];
					if (typeof value !== "string" || referencesIn(value).length === 0) continue;
					const bot = resolved(value, known);
					if (typeof bot === "string" && bot !== "")
						bots.push({ nodeId: node.id, input, bot, source });
				}
			}
		}
		return [
			...(await checkReferencedAgents(deps.db, wanted)).problems,
			...(await checkFeishuBots(deps.db, bots)),
		];
	};
}

/** 一条链和触发时就能知道的它的入口参数。 */
interface KnownParams {
	chain: ChainPlan;
	/** 知道值的参数（不知道的不在里面，引用它们的值解析不出来，跳过）。 */
	params: Record<string, unknown>;
	/** 这条链上的值取自哪里（写进问题的说明）。 */
	source: string;
}

/**
 * 触发时就能知道入口参数的链：主链的入口参数是触发时给的；子流程的入口参数是调度它的异步任务节点按参数映射传入的，
 * 映射的值是常量或只引用了那条链的入口参数时就知道（没有映射的取默认值），引用了前面节点的输出的不知道。
 * 一个子流程被几个异步任务节点调度时各算一次；子流程（间接）调度自己时只算到第一次。
 */
function knownParams(plan: RunPlan, params: Record<string, unknown>): KnownParams[] {
	const found: KnownParams[] = [];
	const visit = (known: KnownParams, path: ReadonlySet<string>) => {
		found.push(known);
		for (const node of known.chain.nodes) {
			if (node.kind !== "async") continue;
			const subflow = plan.chains.get(plan.dispatch.get(node.id) ?? "");
			if (!subflow || path.has(subflow.entry.id)) continue;
			const passed: Record<string, unknown> = {};
			for (const decl of subflow.entry.params) {
				const value = Object.hasOwn(node.params, decl.name)
					? resolved(node.params[decl.name], known.params)
					: (decl.default ?? null);
				if (value !== undefined) passed[decl.name] = value;
			}
			visit(
				{
					chain: subflow,
					params: passed,
					source: `取自子流程的参数，由异步任务节点 ${node.id} 传入`,
				},
				new Set([...path, subflow.entry.id]),
			);
		}
	};
	visit({ chain: plan.main, params, source: "取自入口参数" }, new Set([plan.main.entry.id]));
	return found;
}

/** 只用入口参数 `params` 解析一个值；引用了前面节点的输出、或不知道值的参数时为 undefined。 */
function resolved(value: unknown, params: Record<string, unknown>): unknown {
	try {
		return resolveInputs({ value }, { params, earlierOutputs: new Map() }).value;
	} catch (error) {
		if (error instanceof InvalidReferenceError) return undefined;
		throw error;
	}
}
