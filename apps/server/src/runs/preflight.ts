import {
	agentInputs,
	blocksTrigger,
	feishuBotInputs,
	nodeNameWithId,
	referencedAgents,
	referencesIn,
} from "@sfly/orchestration";
import type { PackageMetadata, StoredOrchestrationDocument } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { agents } from "../db/schema.js";
import { agentFor, planRun, type RunPlan } from "../engine/chain.js";
import { type AgentReference, checkReferencedAgents } from "../engine/referenced-agents.js";
import { type BotToCheck, checkFeishuBots } from "../feishu/bot-checks.js";
import { checkDocument } from "../orchestrations/document-checks.js";
import { findPackageVersion } from "../packages/package-repository.js";
import { controlPlaneAgentProblem } from "../packages/requires-agent.js";
import { controlPlaneSdkProblem } from "../packages/requires-sdk.js";
import { checkDevPackagesLoaded } from "./dev-package-loaded.js";
import { knownParams, resolved } from "./known-params.js";
import { type ParamOrigins, paramInputTypeProblems } from "./param-input-type.js";
import { subflowParamNotPassedWarnings } from "./subflow-param-not-passed.js";

/**
 * 不能触发的一个原因；code 与保存时的警告一致（含「Agent」类型的输入选的 Agent 没有注册过的
 * `agent_input_not_registered`，「飞书机器人」类型的输入选的机器人没有登记的
 * `feishu_bot_not_registered`，场景里还有已移除种类的节点的 `node_kind_removed`），另有 `agent_not_registered`、`not_supported`、`sdk_version_unsatisfied`、
 * `agent_version_unsatisfied`、开发版本没有在节点派发到的在线 Agent 上加载的 `dev_package_not_loaded`
 * （dev-package-loaded.ts），以及触发时入口参数的值接到类型不符的输入的 `param_input_type_mismatch`（param-input-type.ts）。
 * 预检的警告（不阻断触发，{@link preflightWarnings}）也是这个结构。
 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

/**
 * 预检读哪个数据库由调用方传：触发准入（trigger-admission.ts）在事务里调用，传事务对象（#380：预检另从连接池取连接，会和等锁的写入互相等死）。
 * 预检和参数检查读库都是一条接一条地执行，不并发。
 */
export type Preflight = (
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
) => Promise<PreflightProblem[]>;

/** 文档锁定的节点包版本的元信息（包名 → 元信息；控制面没有这个版本的不在里面）。每个包查一次，一个一个地查。 */
async function lockedPackages(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<Map<string, PackageMetadata>> {
	const locked = new Map<string, PackageMetadata>();
	for (const [name, version] of Object.entries(doc.packages)) {
		const published = await findPackageVersion(db, name, version);
		if (published) locked.set(name, published.metadata);
	}
	return locked;
}

/**
 * 触发前的预检（docs/SEMANTICS.md §6）：结构、包版本锁定、引用、输入的静态检查全部通过
 * （「Agent」类型的输入的常量是已注册的 Agent，「飞书机器人」类型的输入的常量是已登记的机器人），
 * 包节点派发到的 Agent 都已注册（不要求在线），
 * 锁定开发版本的节点派发到的在线 Agent 已经加载了它（{@link checkDevPackagesLoaded}，不在线的 Agent 不知道它加载了什么，不阻断），
 * 且控制面版本满足节点包需要的 SDK 版本（#79），节点所在的 Agent 和「Agent」类型的输入引用的 Agent 满足
 * 节点包需要的 Agent 版本（ADR 0019，见 requires-agent.ts）。
 * 返回全部不能触发的原因，空数组表示可以触发。未保存的草稿只存在于浏览器，由画布在触发前检查。
 *
 * 比较的是控制面版本 `version` 而不是 Agent 记录里的版本：只给与控制面版本一致的 Agent 派任务（ADR 0014），
 * 记录里版本不同的 Agent 会先自更新到这个版本，所以 Agent 执行任务时的 SDK 版本就是控制面版本；提示也如实这样写。
 */
export function createPreflight(deps: { version: string }): Preflight {
	return async (db, doc) => {
		// 注释框的警告只提示，不阻断触发（docs/SEMANTICS.md §1.6）。
		const problems: PreflightProblem[] = (await checkDocument(db, doc))
			.filter(blocksTrigger)
			.map((w) => ({
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
						await db.select({ name: agents.name }).from(agents).where(inArray(agents.name, names))
					).map((r) => r.name)
				: [],
		);
		const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
		for (const [nodeId, agent] of wanted) {
			if (registered.has(agent)) continue;
			const node = nodeById.get(nodeId);
			problems.push({
				code: "agent_not_registered",
				message: `节点 ${node ? nodeNameWithId(node) : nodeId} 派发到的 Agent ${agent} 还没有注册过`,
				node_id: nodeId,
			});
		}
		problems.push(...(await checkDevPackagesLoaded(db, doc)));

		const locked = await lockedPackages(db, doc);
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
					message: `节点 ${nodeNameWithId(node)}：${sdk}`,
					node_id: node.id,
				});
			}
			const own = controlPlaneAgentProblem(metadata, pkg, wanted.get(node.id) ?? "", deps.version);
			if (own) {
				problems.push({
					code: "agent_version_unsatisfied",
					message: `节点 ${nodeNameWithId(node)}：${own}`,
					node_id: node.id,
				});
			}
			const type = metadata.nodes.find((n) => n.name === node.node);
			if (!type || metadata.requires_agent === undefined) continue;
			for (const { input, agent } of referencedAgents(type.inputs, node.inputs)) {
				if (referencesIn(agent).length > 0) continue;
				constants.push({
					nodeId: node.id,
					node: nodeNameWithId(node),
					input,
					agent,
					requirement: { metadata, pkg },
				});
			}
		}
		// 没有注册过的常量已经由静态检查（agent_input_not_registered）指出，这里只看版本。
		const referenced = await checkReferencedAgents(db, constants);
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

/**
 * 触发前预检的警告（docs/SEMANTICS.md §6）：不阻断触发，但配置很可能不是作者想要的，要跑到那个节点才会失败。
 * 和 {@link Preflight} 的问题同一个结构，只看文档，不读库；预检接口（`GET /orchestrations/:id/preflight`）的 `warnings`，
 * 控制台的触发对话框和 `sfly run start` 都读它。
 */
export function preflightWarnings(doc: StoredOrchestrationDocument): PreflightProblem[] {
	return [...subflowParamNotPassedWarnings(doc)];
}

/** 触发时按入口参数的实际值做的检查（{@link createParamsCheck}）。 */
export type ParamsCheck = (
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
	plan: RunPlan,
	params: Record<string, unknown>,
	origins: ParamOrigins,
) => Promise<PreflightProblem[]>;

/**
 * 触发时按入口参数的实际值检查：「Agent」类型的输入引用入口参数时，取到的 Agent 必须已注册（不要求在线），
 * 版本满足节点包需要的 Agent 版本（`requires_agent`，{@link checkReferencedAgents}）；
 * 「飞书机器人」类型的输入引用入口参数的机器人，取到的必须是已登记的飞书机器人（{@link checkFeishuBots}）。
 * 整个引用入口参数的节点输入，值（触发时给的值、运行预设里的值、默认值，子流程里是异步任务节点传入的值）
 * 的类型要符合输入的类型，判断和派发时是同一个（{@link paramInputTypeProblems}）。
 * 主链和子流程都检查（{@link knownParams}）；引用了前面节点输出的值要到派发时才知道，这里跳过。
 */
export function createParamsCheck(): ParamsCheck {
	return async (db, doc, plan, params, origins) => {
		const locked = await lockedPackages(db, doc);
		const wanted: AgentReference[] = [];
		const bots: BotToCheck[] = [];
		const chains = knownParams(plan, params);
		for (const { chain, params: known, source } of chains) {
			for (const node of chain.nodes) {
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
						wanted.push({
							nodeId: node.id,
							node: nodeNameWithId(node),
							input,
							agent,
							requirement,
							source,
						});
				}
				for (const input of feishuBotInputs(type.inputs)) {
					const value = node.inputs[input];
					if (typeof value !== "string" || referencesIn(value).length === 0) continue;
					const bot = resolved(value, known);
					if (typeof bot === "string" && bot !== "")
						bots.push({ nodeId: node.id, node: nodeNameWithId(node), input, bot, source });
				}
			}
		}
		return [
			...(await checkReferencedAgents(db, wanted)).problems,
			...(await checkFeishuBots(db, bots)),
			...paramInputTypeProblems(plan.main, chains, locked, origins),
		];
	};
}
