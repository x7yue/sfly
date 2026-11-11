/**
 * 在已有节点 ID 中为新节点生成一个不重复的 ID：前缀（非法字符换成下划线，为空时用 node）后面接序号。
 * 画布上添加节点、新建子流程入口、粘贴与创建副本都用它。
 */
export function uniqueNodeId(base: string, existing: Iterable<string>): string {
	const taken = new Set(existing);
	const stem = base.replace(/[^A-Za-z0-9_]/g, "_") || "node";
	for (let i = 1; ; i++) {
		const id = `${stem}_${i}`;
		if (!taken.has(id)) return id;
	}
}
