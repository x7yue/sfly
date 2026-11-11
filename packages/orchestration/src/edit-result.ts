/**
 * 文档操作（chain-edits、node-clipboard）共用的结果类型：成功时是新文档，粘贴、创建副本等再带上
 * 操作产生的其他结果（新节点的 ID）；被拒绝时是写给用户看的原因。
 */

/** 被拒绝的操作。 */
export interface Rejected {
	ok: false;
	reason: string;
}

/** 文档操作的结果：新文档（和 `Extra` 里的其他结果），或拒绝原因。 */
export type DocumentEdit<D, Extra extends object = Record<never, never>> =
	| ({ ok: true; doc: D } & Extra)
	| Rejected;

export const rejected = (reason: string): Rejected => ({ ok: false, reason });
