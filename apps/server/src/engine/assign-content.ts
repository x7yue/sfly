import type { MessageInitShape } from "@bufbuild/protobuf";
import {
	InvalidReferenceError,
	inputProblems,
	NODE_DEFAULTS,
	type ResolveScope,
	referencedFeishuBots,
	resolveInputs,
} from "@sfly/orchestration";
import type { AssignTaskSchema } from "@sfly/proto";
import type { PackageMetadata } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import { type AgentInfo, nodePackages } from "../db/schema.js";
import { agentRequirementProblem } from "../packages/requires-agent.js";
import { sdkRequirementProblem } from "../packages/requires-sdk.js";
import type { PackageNode } from "./chain.js";
import { isAlways } from "./failures.js";
import { resolveReferencedAgents } from "./referenced-agents.js";
import type { TaskRow, Tx } from "./step.js";

/** 包节点默认超时：1 小时（docs/SEMANTICS.md §3.3）。 */
const DEFAULT_TIMEOUT_SECONDS = NODE_DEFAULTS.timeout;

/** 开发版本（docs/SEMANTICS.md §7）。 */
export const DEV_VERSION = "dev";

/** 这次尝试派给的 Agent：名称、版本，以及它以开发模式加载的节点包（开发版本的元信息由它上报）。 */
export interface AssignTarget {
	name: string;
	info: Pick<AgentInfo, "agent_version" | "dev_packages">;
}

export interface AssignRequest {
	task: Pick<TaskRow, "id" | "attempt" | "runId">;
	node: PackageNode;
	/** 场景版本锁定的这个节点包的版本；没有锁定时为空串。 */
	packageVersion: string;
	/** 解析这个节点输入里的引用用的作用域（本链的入口参数和前面已成功节点的输出）。 */
	scope: ResolveScope;
	target: AssignTarget;
}

/**
 * 这次尝试派什么，或者为什么派不了：
 * - 可以：已解析的输入、「飞书机器人」类型的输入引用的机器人（调用方记在任务上），和要发给 Agent 的 AssignTask 内容。
 * - 不能：任务以 `kind` 失败（不重试）。`inputs` 是已经解析出来的输入，调用方先把它记在任务上再失败；
 *   引用没有解析出来、节点包版本不满足时还没有可记的输入，不给。
 */
export type AssignContent =
	| {
			ok: true;
			inputs: Record<string, unknown>;
			referencedFeishuBots: string[];
			assign: MessageInitShape<typeof AssignTaskSchema>;
	  }
	| {
			ok: false;
			kind: "config_error" | "env_error";
			message: string;
			inputs?: Record<string, unknown>;
	  };

/**
 * 解析输入、检查节点包对 SDK 和 Agent 版本的要求、按节点类型的输入 schema 校验、解析引用的 Agent，
 * 回答这次尝试的派发内容。只读：任务的状态、租约和失败都由调用方在同一个事务里写。
 */
export type AssignContentOf = (tx: Tx, request: AssignRequest) => Promise<AssignContent>;

/** `urls` 是 Agent 下载节点包归档、上传任务产物的地址（Agent 通过 HTTP 访问）。 */
export function createAssignContent(urls: {
	packageArchiveUrl: (name: string, version: string) => string;
	artifactUploadUrl: (taskId: string) => string;
}): AssignContentOf {
	return async (tx, { task, node, packageVersion, scope, target }) => {
		let inputs: Record<string, unknown>;
		try {
			inputs = resolveInputs(node.inputs, scope);
		} catch (error) {
			if (!(error instanceof InvalidReferenceError)) throw error;
			return { ok: false, kind: "config_error", message: error.message };
		}

		// 包版本没有安装在 Agent 上时，Agent 按这里的地址下载并校验 sha256；控制面没有该版本时留空。
		const [archive] = await tx
			.select({ sha256: nodePackages.sha256, metadata: nodePackages.metadata })
			.from(nodePackages)
			.where(and(eq(nodePackages.name, node.package), eq(nodePackages.version, packageVersion)));
		// 开发版本的元信息由加载它的 Agent 上报；不知道节点类型时不校验（Agent 会以 env_error 失败）。
		const metadata =
			archive?.metadata ??
			(packageVersion === DEV_VERSION
				? (target.info.dev_packages?.find((p) => p.name === node.package)?.metadata as
						| PackageMetadata
						| null
						| undefined)
				: undefined);
		// 节点包需要的 SDK 比 Agent 上的新：在 Agent 上运行只会得到难以理解的错误（#79）。
		const pkg = { name: node.package, version: packageVersion };
		const self = { name: target.name, version: target.info.agent_version };
		// 节点包需要的 Agent 版本（ADR 0019）：节点所在的 Agent 在这里查，引用的 Agent 在 resolveReferencedAgents 里查。
		const versionProblem =
			metadata &&
			(sdkRequirementProblem(metadata, pkg, self) ?? agentRequirementProblem(metadata, pkg, self));
		if (versionProblem) return { ok: false, kind: "env_error", message: versionProblem };
		const type = metadata?.nodes?.find((n) => n.name === node.node);
		const problems = type ? inputProblems(type.inputs, inputs, { allowNull: isAlways(node) }) : [];
		if (problems.length > 0) {
			return { ok: false, kind: "config_error", message: problems.join("; "), inputs };
		}
		// 「Agent」类型的输入引用的 Agent：必须已注册，地址和端口随任务下发（ADR 0019）。
		const referenced = type
			? await resolveReferencedAgents(tx, node.id, type.inputs, inputs, {
					metadata: metadata ?? {},
					pkg,
				})
			: { agents: [] };
		if ("problems" in referenced) {
			return { ok: false, kind: referenced.kind, message: referenced.problems.join("; "), inputs };
		}

		// 「飞书机器人」类型的输入引用的机器人名单随任务下发，也记在任务上：ctx.notify 只能发给其中的机器人（ADR 0020）。
		// 不在这里检查是否已登记：值来自前面节点的输出时派发时才知道，而通知不能成为任务失败的原因，发送时再检查。
		const bots = type
			? [...new Set(referencedFeishuBots(type.inputs, inputs).map((r) => r.bot))]
			: [];
		return {
			ok: true,
			inputs,
			referencedFeishuBots: bots,
			assign: {
				taskId: task.id,
				attempt: task.attempt,
				package: node.package,
				packageVersion,
				node: node.node,
				inputsJson: JSON.stringify(inputs),
				timeoutSeconds: node.timeout ?? DEFAULT_TIMEOUT_SECONDS,
				runId: task.runId,
				nodeId: node.id,
				packageSha256: archive?.sha256 ?? "",
				packageUrl: archive ? urls.packageArchiveUrl(node.package, packageVersion) : "",
				artifactUploadUrl: urls.artifactUploadUrl(task.id),
				referencedAgents: referenced.agents,
				referencedFeishuBots: bots,
			},
		};
	};
}
