// 会话令牌触发、会话没勾选「联调时可以使用项目密钥」的运行不解析 secret 参数（#497，ADR 0029「助手会话」）：场景版本里内嵌的值
// （入口和子流程入口的默认值、异步任务节点传给子流程 secret 参数的常量）和运行预设里的值都当作没有提供，只用触发请求里给的值。
import { referencesIn } from "@sfly/orchestration";
import type { ParamDeclaration, StoredNode } from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { sessions } from "../db/schema.js";
import type { RunPlan } from "../engine/chain.js";

export const SECRETS_WITHHELD = "secret_params_withheld";

/** 预检里给会话看的警告的错误码（{@link withheldWarnings}）。 */
export const SECRET_PARAM_WITHHELD = "secret_param_withheld";

/** 派发时报类型不符、输入取自不解析的 secret 参数时，错误信息里写明的原因。 */
export const WITHHELD_REASON = "会话触发的运行不解析 secret 参数";

const HOW_TO_ALLOW = "在触发请求里给它值，或者请发起人在会话页勾选「联调时可以使用项目密钥」";

/** 经这个会话触发的运行要不要不解析 secret 参数：会话没勾选「联调时可以使用项目密钥」时要；不是会话（人触发）时不要。 */
export async function withholdsSecrets(db: Db | Tx, sessionId: string | null): Promise<boolean> {
	if (sessionId === null) return false;
	const [session] = await db
		.select({ allowed: sessions.useProjectSecrets })
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	return session?.allowed !== true;
}

/** 声明里去掉 secret 参数的默认值。 */
export function withoutSecretDefaults(declarations: ParamDeclaration[]): ParamDeclaration[] {
	return declarations.map((d) => {
		if (!d.secret || d.default === undefined) return d;
		const { default: _, ...rest } = d;
		return rest;
	});
}

/** 运行预设的值里去掉 secret 参数。 */
export function withoutSecretValues(
	values: Record<string, unknown>,
	declarations: readonly ParamDeclaration[],
): Record<string, unknown> {
	const secrets = new Set(declarations.filter((d) => d.secret).map((d) => d.name));
	return Object.fromEntries(Object.entries(values).filter(([name]) => !secrets.has(name)));
}

/** 异步任务节点传给子流程的值里，去掉传给 secret 参数的常量（不含引用的值）。 */
export function withoutSecretConstants(
	mapping: Record<string, unknown>,
	declarations: readonly ParamDeclaration[],
): Record<string, unknown> {
	const secrets = new Set(declarations.filter((d) => d.secret).map((d) => d.name));
	return Object.fromEntries(
		Object.entries(mapping).filter(
			([name, value]) => !secrets.has(name) || referencesIn(value).length > 0,
		),
	);
}

/**
 * 不解析之后缺了的必填 secret 参数，每个一句说明：主链入口的请求里没给（`provided` 是套用预设之后的值，预设里的 secret 值已经去掉）；
 * 子流程入口的只由默认值或常量提供（{@link withheldSubflowProblems}）。
 */
export function withheldProblems(plan: RunPlan, provided: Record<string, unknown>): string[] {
	const main = plan.main.entry.params
		.filter((d) => d.secret && d.required && (provided[d.name] ?? null) === null)
		.map(
			(d) =>
				`参数 ${d.name} 是 secret 参数，${WITHHELD_REASON}（场景里的默认值、运行预设里的值都不用）：${HOW_TO_ALLOW}`,
		);
	return [...main, ...withheldSubflowProblems(plan)];
}

/** 子流程入口的必填 secret 参数只由默认值或常量提供：不解析之后一定缺，触发请求里给什么都补不上。 */
export function withheldSubflowProblems(plan: RunPlan): string[] {
	return fixedSubflowSecrets(plan)
		.filter(({ param }) => param.required)
		.map(
			({ subflow, param, source }) =>
				`子流程 ${subflow} 的 secret 参数 ${param.name} 由${source}提供，${WITHHELD_REASON}：改成在触发请求里给值、经入口参数传进去，或者请发起人在会话页勾选「联调时可以使用项目密钥」`,
		);
}

/**
 * 预检里给会话（没勾选时）看的警告：主链入口的 secret 参数只认触发请求里给的值；子流程入口的可选 secret 参数只由默认值或常量提供时，
 * 节点拿到 null。
 */
export function withheldWarnings(plan: RunPlan): string[] {
	const main = plan.main.entry.params
		.filter((d) => d.secret)
		.map(
			(d) =>
				`参数 ${d.name} 是 secret 参数，${WITHHELD_REASON}（场景里的默认值、运行预设里的值都不用）：${d.required ? "触发请求里要给它值" : "触发请求里不给值时节点拿到 null"}，或者请发起人在会话页勾选「联调时可以使用项目密钥」`,
		);
	const sub = fixedSubflowSecrets(plan)
		.filter(({ param }) => !param.required)
		.map(
			({ subflow, param, source }) =>
				`子流程 ${subflow} 的 secret 参数 ${param.name} 由${source}提供，${WITHHELD_REASON}：节点拿到 null`,
		);
	return [...main, ...sub];
}

/** 子流程入口的 secret 参数里，由场景里内嵌的值（默认值、异步任务节点传的常量）提供的。 */
function fixedSubflowSecrets(
	plan: RunPlan,
): { subflow: string; param: ParamDeclaration; source: string }[] {
	const found: { subflow: string; param: ParamDeclaration; source: string }[] = [];
	for (const chain of plan.chains.values()) {
		for (const node of chain.nodes) {
			if (node.kind !== "async") continue;
			const sub = plan.chains.get(plan.dispatch.get(node.id) ?? "");
			if (!sub) continue;
			for (const param of sub.entry.params) {
				if (!param.secret) continue;
				const source = fixedSource(node, param);
				if (source !== undefined) found.push({ subflow: subflowName(sub.entry), param, source });
			}
		}
	}
	return found;
}

/** 子流程的这个 secret 参数由场景里内嵌的值提供时，说是哪一种；由引用提供或者没有值时 undefined。 */
function fixedSource(
	node: Extract<StoredNode, { kind: "async" }>,
	d: ParamDeclaration,
): string | undefined {
	const mapped = node.params[d.name];
	if (mapped === undefined) return d.default == null ? undefined : "它自己的默认值";
	if (mapped === null || referencesIn(mapped).length > 0) return undefined;
	return `异步任务节点 ${node.id} 传的常量`;
}

const subflowName = (entry: { id: string; name?: string | undefined }) =>
	entry.name ? `${entry.name}（${entry.id}）` : entry.id;

/**
 * 派发时输入不符合节点的 schema、不符的输入整值取自这次运行不解析的 secret 参数（值是 null）时，补在错误信息后面的原因；
 * 没有这种输入时是空字符串。
 */
export function withheldNote(
	nodeInputs: Record<string, unknown>,
	inputs: Record<string, unknown>,
	chainParams: Record<string, unknown>,
	declarations: readonly ParamDeclaration[],
): string {
	const names = declarations
		.filter((d) => d.secret && (chainParams[d.name] ?? null) === null)
		.map((d) => d.name)
		.filter((name) =>
			Object.entries(nodeInputs).some(
				([input, value]) =>
					inputs[input] === null && referencesIn(value).includes(`params.${name}`),
			),
		);
	return names.length === 0 ? "" : `（${WITHHELD_REASON}：${names.join("、")} 是 null）`;
}
