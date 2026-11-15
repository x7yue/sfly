/** 链和子流程的显示名称（GLOSSARY「主链」「子流程」）：画布、运行监控和运行通知的卡片共用，不各写一份。 */

/** 主链的名称。 */
export const MAIN_CHAIN_LABEL = "主链";
/** 子流程在链名称里的称呼：`子流程 <名称>`。 */
export const SUBFLOW_LABEL = "子流程";
/** 名称为空的子流程显示的名称。 */
export const UNNAMED_SUBFLOW_LABEL = "未命名子流程";

/**
 * 子流程的名称（GLOSSARY「子流程」）：子流程入口节点上填写的名称，去掉首尾空白；
 * 没有名称字段的旧版本以节点 ID 作为名称（ADR 0016）。填了空名称时为空字符串。
 */
export const subflowName = (node: { id: string; name?: string | undefined }): string =>
	node.name === undefined ? node.id : node.name.trim();

/** 运行、链实例等 ID 的短形式（前 8 位）。 */
export const shortId = (id: string): string => id.slice(0, 8);

/**
 * 子流程的显示名称：子流程名称（{@link subflowName}），没有名称字段的旧版本显示节点 ID，
 * 填了空名称时显示 {@link UNNAMED_SUBFLOW_LABEL}。
 */
export const subflowLabel = (node: { id: string; name?: string | null | undefined }): string =>
	subflowName({ id: node.id, name: node.name ?? undefined }) || UNNAMED_SUBFLOW_LABEL;

/**
 * 链实例的名称：「主链」或「子流程 <名称>」（`chain_id` 是子流程入口节点的 ID，`name` 是它的名称）；
 * 给出实例 ID 时带上实例短 ID（同一子流程有多个实例时区分）：「子流程 <名称> · <实例短 ID>」。
 */
export function chainLabel(
	chain: { chain_id: string; subflow: boolean; name?: string | null | undefined },
	instanceId?: string,
): string {
	if (!chain.subflow) return MAIN_CHAIN_LABEL;
	const name = `${SUBFLOW_LABEL} ${subflowLabel({ id: chain.chain_id, name: chain.name })}`;
	return instanceId ? `${name} · ${shortId(instanceId)}` : name;
}
