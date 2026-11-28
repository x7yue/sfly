// 写入时打码（#505，ADR 0029「密钥」）：引擎写进库的参数、输入、输出、错误先按运行的原值集合打码，原值留在运行的加密副本里，
// 解析引用时从副本取回。没有标记的运行（`runs.masked_on_write`）原样写，照旧在读取时打码。
import { type ResolveScope, resolveInputs } from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import { eq } from "drizzle-orm";
import { runs } from "../db/schema.js";
import {
	maskParams,
	maskRecord,
	type SecretSet,
	secretParamNames,
	secretParamValues,
	secretSetOf,
} from "../logs/secrets.js";
import type { RunSecrets } from "../secrets/run-secrets.js";
import type { RunVault } from "../secrets/run-vault.js";
import { asStoredJson } from "../util/jsonb.js";
import type { RunPlan } from "./chain.js";
import type { RunRow, Step } from "./step.js";

/** 写进 jsonb 再读回来的样子（键序，`util/jsonb.ts`）：副本里的原值和以前从库里读回来的原值一样，打码认的写法也一样。 */
const stored = (value: Record<string, unknown>) => asStoredJson(value) as Record<string, unknown>;

/** 加进值集合（同一个值只记一次）。 */
function withValues(vault: RunVault, values: readonly unknown[]): RunVault {
	const known = new Set(vault.values.map((v) => JSON.stringify(v)));
	const added = values.filter((v) => !known.has(JSON.stringify(v)));
	return added.length === 0 ? vault : { ...vault, values: [...vault.values, ...added] };
}

/** 打码前后不一样的那些键的原值：解析引用时盖回打码后的那一份上。 */
function changed(
	raw: Record<string, unknown>,
	masked: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(raw).filter(([key, value]) => masked[key] !== value));
}

/**
 * 触发时就知道的 secret 值：入口声明为 secret 的参数；各个异步任务节点映射进子流程 secret 参数的值里，只用常量、
 * 和主链上只用运行参数的（映射引用上游输出的，要等上游交结果才知道，在创建子流程实例时再加）。
 */
export function valuesKnownAtTrigger(
	document: StoredOrchestrationDocument,
	plan: RunPlan,
	params: Record<string, unknown>,
): unknown[] {
	const values = secretParamValues(plan.main.entry.params, params);
	for (const chain of plan.chains.values()) {
		const scope: ResolveScope = {
			params: chain === plan.main ? params : {},
			earlierOutputs: new Map(),
		};
		for (const node of chain.nodes) {
			if (node.kind !== "async") continue;
			const target = plan.chains.get(plan.dispatch.get(node.id) ?? "");
			if (!target) continue;
			const secret = secretParamNames(document, target.entry.id);
			for (const [name, expression] of Object.entries(node.params)) {
				if (!secret.has(name)) continue;
				try {
					const value = resolveInputs({ value: expression }, scope).value;
					if (value !== undefined && value !== null) values.push(value);
				} catch {
					// 引用了上游输出或子流程自己的参数：创建子流程实例时才知道。
				}
			}
		}
	}
	return values;
}

/** 引擎写进库之前打码；不在写入时打码的运行原样返回。 */
export class WriteMasking {
	constructor(private readonly secrets: RunSecrets) {}

	/**
	 * 新运行：打码后的参数（存进 `runs.params` 和主链实例），和它的副本（原值集合、主链参数里打码后不一样的原值）。
	 * 副本在运行那一行写进库之后用 {@link saveVault} 存。
	 */
	firstVault(at: {
		document: StoredOrchestrationDocument;
		plan: RunPlan;
		chainInstanceId: string;
		params: Record<string, unknown>;
	}): { params: Record<string, unknown>; oversize: boolean; vault: RunVault } {
		const empty: RunVault = { values: [], params: {}, outputs: {} };
		const raw = stored(at.params);
		const vault = withValues(empty, valuesKnownAtTrigger(at.document, at.plan, raw));
		const set = secretSetOf(vault.values);
		const params = maskParams(raw, secretParamNames(at.document, at.plan.main.entry.id), set);
		return {
			params,
			oversize: set.oversize,
			vault: { ...vault, params: { [at.chainInstanceId]: changed(raw, params) } },
		};
	}

	saveVault(step: Step, runId: string, vault: RunVault): Promise<void> {
		return this.secrets.write(step, runId, vault);
	}

	/** 子流程实例的参数：它的 secret 参数的值加进原值集合，返回打码后的参数（存进链实例和异步任务节点的输入）。 */
	async chainParams(
		step: Step,
		run: RunRow,
		at: {
			document: StoredOrchestrationDocument;
			chainId: string;
			chainInstanceId: string;
			declarations: ReadonlyArray<{ name: string; secret?: boolean | undefined }>;
			params: Record<string, unknown>;
		},
	): Promise<Record<string, unknown>> {
		if (!run.maskedOnWrite) return at.params;
		const raw = stored(at.params);
		const before = await this.secrets.vault(step, run.id);
		const grown = withValues(before, secretParamValues(at.declarations, raw));
		const set = secretSetOf(grown.values);
		const params = maskParams(raw, secretParamNames(at.document, at.chainId), set);
		if (set.oversize && !run.secretsOversize) {
			await step.tx.update(runs).set({ secretsOversize: true }).where(eq(runs.id, run.id));
		}
		await this.secrets.write(step, run.id, {
			...grown,
			params: { ...grown.params, [at.chainInstanceId]: changed(raw, params) },
		});
		return params;
	}

	/** 节点的输出：返回打码后的（存进 `tasks.outputs`），和打码后不一样时原样的一份留在副本里给下游解析。 */
	async outputs(
		step: Step,
		run: RunRow,
		taskId: string,
		outputs: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!run.maskedOnWrite) return outputs;
		const vault = await this.secrets.vault(step, run.id);
		const raw = stored(outputs);
		const masked = maskRecord(raw, secretSetOf(vault.values));
		if (masked === raw) return outputs;
		await this.secrets.write(step, run.id, {
			...vault,
			outputs: { ...vault.outputs, [taskId]: raw },
		});
		return masked;
	}

	/** 这次运行此刻的值集合；不在写入时打码的运行是 undefined。 */
	async set(step: Step, run: RunRow): Promise<SecretSet | undefined> {
		if (!run.maskedOnWrite) return undefined;
		return secretSetOf((await this.secrets.vault(step, run.id)).values);
	}

	/** 任务的输入（包节点派发时解析出来的）。 */
	async record(
		step: Step,
		run: RunRow,
		value: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const set = await this.set(step, run);
		return set ? maskRecord(value, set) : value;
	}

	/** 错误信息、错误位置。 */
	async text<T extends string | undefined>(step: Step, run: RunRow, text: T): Promise<T> {
		if (text === undefined || text === "") return text;
		const set = await this.set(step, run);
		return (set ? set.mask(text) : text) as T;
	}

	/** 解析引用的作用域换成原值：参数、前面节点的输出里打码过的，从副本取回。 */
	async rawScope(
		step: Step,
		run: RunRow,
		chainInstanceId: string,
		scope: ResolveScope,
		taskIds: ReadonlyMap<string, string>,
	): Promise<ResolveScope> {
		if (!run.maskedOnWrite) return scope;
		const vault = await this.secrets.vault(step, run.id);
		const earlierOutputs = new Map(scope.earlierOutputs);
		for (const [nodeId, taskId] of taskIds) {
			const raw = vault.outputs[taskId];
			if (raw) earlierOutputs.set(nodeId, raw);
		}
		return {
			...scope,
			params: { ...scope.params, ...vault.params[chainInstanceId] },
			earlierOutputs,
		};
	}
}
