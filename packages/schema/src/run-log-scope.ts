import { z } from "zod";

/**
 * 按运行读取日志的节点范围（#224，docs/ARCHITECTURE.md §6.3）：一组节点，用「链路实例 ID + 节点 ID」表示，
 * 范围内每个节点的每一次尝试都算。分页、实时推送（#225）、下载（#226）共用这里的类型、查询参数写法和判断函数：
 * 不给范围表示全部节点，给了空列表表示没有节点。
 *
 * 查询参数 `nodes` 的写法：每条链一组，组之间用 `;`，链后面跟 `:` 和这条链上的节点，节点之间用 `,`；
 * 链实例 ID 和节点 ID 各自按 encodeURIComponent 转义，所以节点 ID 里可以有 `, ; : %` 等任意字符。
 * 同一条链的节点合在一组，几百个节点的范围也只有几 KB，放得进 URL。
 *
 *   ?nodes=3f2c…:fetch,verify;9a10…:probe
 */

export const RunLogNode = z.object({
	chain_instance_id: z.string().min(1),
	node_id: z.string().min(1),
});

export const RunLogScope = z.array(RunLogNode);

export type RunLogNode = z.infer<typeof RunLogNode>;
export type RunLogScope = z.infer<typeof RunLogScope>;

/** 每条链上范围内的节点（同一个节点只算一次），链按第一次出现的顺序。 */
function nodesByChain(scope: RunLogScope): Map<string, Set<string>> {
	const chains = new Map<string, Set<string>>();
	for (const { chain_instance_id, node_id } of scope) {
		const nodes = chains.get(chain_instance_id) ?? new Set<string>();
		nodes.add(node_id);
		chains.set(chain_instance_id, nodes);
	}
	return chains;
}

/** 范围写成 `nodes` 查询参数的值；空范围是空字符串。 */
export function encodeRunLogScope(scope: RunLogScope): string {
	return [...nodesByChain(scope)]
		.map(
			([chain, nodes]) =>
				`${encodeURIComponent(chain)}:${[...nodes].map(encodeURIComponent).join(",")}`,
		)
		.join(";");
}

/** 不是 {@link encodeRunLogScope} 写出来的格式时为 undefined。 */
export function decodeRunLogScope(text: string): RunLogScope | undefined {
	if (text === "") return [];
	const scope: RunLogScope = [];
	try {
		for (const group of text.split(";")) {
			const colon = group.indexOf(":");
			if (colon < 0) return undefined;
			const chain = decodeURIComponent(group.slice(0, colon));
			if (!chain) return undefined;
			for (const node of group.slice(colon + 1).split(",")) {
				const node_id = decodeURIComponent(node);
				if (!node_id) return undefined;
				scope.push({ chain_instance_id: chain, node_id });
			}
		}
	} catch {
		return undefined;
	}
	return scope;
}

/** `nodes` 查询参数：请求侧是字符串，解析成 {@link RunLogScope}；没有这个参数（undefined）表示全部节点。 */
export const RunLogNodesParam = z.string().transform((text, ctx) => {
	const scope = decodeRunLogScope(text);
	if (!scope) {
		ctx.addIssue({ code: "custom", message: "nodes 不是「链实例:节点,节点;…」的写法" });
		return z.NEVER;
	}
	return scope;
});

/** 一个节点在不在范围内；范围是 undefined（全部节点）时都在。多次判断时先调用一次再复用返回的函数。 */
export function runLogScopeMatcher(scope: RunLogScope | undefined): (node: RunLogNode) => boolean {
	if (!scope) return () => true;
	const chains = nodesByChain(scope);
	return (node) => chains.get(node.chain_instance_id)?.has(node.node_id) ?? false;
}
