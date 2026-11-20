import {
	type OrchestrationDocument,
	type OrchestrationNode,
	SECRET_MASK,
	SECRET_PARAM_DEFAULT_WARNING,
	type SecretDefaultProblem,
} from "@sfly/schema";

/*
 * 场景版本里 secret 参数的默认值（docs/SEMANTICS.md §2.1）：库里是明文，场景版本离开存储层的那一处
 * （`OrchestrationStore` 的 `toVersionView`）经 {@link maskSecretDefaults} 打码，所有读取接口返回的都是占位符 `******`，
 * 和运行参数、运行预设的 secret 值同一个掩码。引擎、触发准入这些需要原值的地方在自己的事务里读库，不经过这里。
 *
 * 读出来的文档原样存回去（下载、修改、再上传）时，占位符不能成为新的默认值：保存时 {@link restoreSecretDefaults}
 * 按「沿用上一个版本的值」把占位符换回原值；沿用不了的（没有上一个版本、没有同名参数……）拒绝保存。
 */

type EntryNode = Extract<OrchestrationNode, { kind: "entry" | "subflow_entry" }>;
type Param = EntryNode["params"][number];

const isEntry = (node: OrchestrationNode): node is EntryNode =>
	node.kind === "entry" || node.kind === "subflow_entry";

/** 有没有默认值：没写（undefined）和 null 都是没有，和触发时补参数（`fillParams`）一致。 */
const hasValue = (value: unknown): boolean => value !== undefined && value !== null;

/** 读出来要打码的默认值：secret 参数写了默认值。 */
const hasSecretDefault = (param: Param): boolean => param.secret && hasValue(param.default);

/**
 * 给文档里 secret 参数的默认值打码：默认值整个换成 {@link SECRET_MASK}，不论类型（和运行预设的视图一样按整个值替换）。
 * 有没有默认值打码前后不变（没有默认值、默认值是 null 的不动），必填检查、预检看的是这一点。
 */
export function maskSecretDefaults(document: OrchestrationDocument): OrchestrationDocument {
	if (!document.nodes.some((n) => isEntry(n) && n.params.some(hasSecretDefault))) return document;
	return {
		...document,
		nodes: document.nodes.map((node) =>
			isEntry(node)
				? {
						...node,
						params: node.params.map((p) =>
							hasSecretDefault(p) ? { ...p, default: SECRET_MASK } : p,
						),
					}
				: node,
		),
	};
}

/** 保存时发现占位符沿用不了：返回的问题清单，每项一个参数，写明是哪个入口节点的哪个参数、为什么。 */
export type RestoreResult =
	| { document: OrchestrationDocument }
	| { problems: SecretDefaultProblem[] };

/**
 * 保存时把占位符换回原值。`previous` 是编辑起点的版本（保存要求 base_version 就是最新版本，所以就是最新版本）的原始文档，
 * 还没有版本时为 undefined。按（入口节点 ID，参数名）对应：
 *
 * - secret 参数的默认值是占位符：沿用上一个版本里同名参数的默认值。上一个版本里没有这个参数、没有默认值，或者类型变了，
 *   沿用不了，拒绝（`no_previous_value`、`type_changed`）：占位符不是一个值，不能存成默认值。
 * - 参数从 secret 改成了普通参数、默认值仍是占位符：拒绝（`unsecured`）。沿用原值会让它明文显示，存占位符会成为一个错误的默认值，
 *   由调用方重新给一个默认值，或者去掉它。
 * - 普通参数的默认值恰好是 `******`：没有打码过，就是这个字符串，原样保存（上一个版本里它也不是 secret 默认值）。
 *
 * 所以 secret 参数的默认值写不成 `******` 本身：它永远表示占位符。不改文档里别的东西。
 */
export function restoreSecretDefaults(
	previous: OrchestrationDocument | undefined,
	incoming: OrchestrationDocument,
): RestoreResult {
	const problems: SecretDefaultProblem[] = [];
	const nodes = incoming.nodes.map((node) => {
		if (!isEntry(node) || !node.params.some((p) => p.default === SECRET_MASK)) return node;
		const before = previous?.nodes.find((n) => n.id === node.id);
		const earlier = before && isEntry(before) ? before.params : [];
		const params = node.params.map((param): Param => {
			if (param.default !== SECRET_MASK) return param;
			const was = earlier.find((p) => p.name === param.name);
			const problem = (reason: SecretDefaultProblem["reason"]) => {
				problems.push({ node_id: node.id, param: param.name, reason });
				return param;
			};
			if (!param.secret) {
				return was && hasSecretDefault(was) && was.default !== SECRET_MASK
					? problem("unsecured")
					: param;
			}
			if (!was || !hasValue(was.default)) return problem("no_previous_value");
			if (was.type !== param.type) return problem("type_changed");
			return { ...param, default: was.default };
		});
		return { ...node, params };
	});
	return problems.length > 0 ? { problems } : { document: { ...incoming, nodes } };
}

/** 一个沿用不了的占位符，写成给人看的一句话（保存被拒绝时的错误信息）。 */
export function describeSecretDefaultProblem({
	node_id: node,
	param,
	reason,
}: SecretDefaultProblem): string {
	const where = `参数 ${param}（入口节点 ${node}）的默认值是 ${SECRET_MASK}`;
	const fix = "请给出这个参数的默认值，或者去掉它的默认值";
	switch (reason) {
		case "no_previous_value":
			return `${where}：读取场景时 secret 参数的默认值打码成 ${SECRET_MASK}，保存时它表示「沿用上一个版本里同名参数的默认值」，但上一个版本里没有可以沿用的（场景还没有保存过版本、没有这个参数，或者它没有默认值）。${fix}`;
		case "type_changed":
			return `${where}，而这个参数的类型变了：上一个版本里的默认值是另一种类型，不能沿用。${fix}`;
		case "unsecured":
			return `${where}，而它已经不是 secret 参数：这个占位符不能存成默认值，原来的 secret 默认值也不会带到普通参数上（那会明文显示）。${fix}`;
	}
}

/**
 * 保存（和恢复）出新版本时的提醒：secret 参数写了默认值。版本只追加、不能修改，默认值会一直留在这个版本里
 * （读取接口打码，库里是明文），也留在之后每个沿用它的版本里。不阻断保存：已有的场景在用。
 * 判断的是有没有默认值，不看值，所以对打码后的文档也成立。
 */
export function secretDefaultWarnings(
	document: OrchestrationDocument,
): Array<{ code: string; message: string; node_id: string }> {
	return document.nodes.filter(isEntry).flatMap((node) =>
		node.params.filter(hasSecretDefault).map((param) => ({
			code: SECRET_PARAM_DEFAULT_WARNING,
			node_id: node.id,
			message: `参数 ${param.name} 是 secret 参数却写了默认值：版本保存之后不能修改，默认值会一直留在这个版本里。建议去掉默认值，改用运行预设固定它，或者触发时再给出`,
		})),
	);
}
