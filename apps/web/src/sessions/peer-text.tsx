/**
 * 别人写的文字（会话的标题、发起人的昵称、用户的话、通知里引用的话）在会话页和助手页里的**唯一出口**：行内的放进 `<bdi>`
 * （{@link PeerText}），方向跟着文字自己走，一个名字里从右到左的字母不把周围的文案顺序带反；**自己单独占一格的**
 * （表格单元格）用 {@link peerBlockProps}：同样的隔离，写在这一格上。夹在控制台自己的文案中间的别人的文字，只把它自己放进来，
 * 控制台的字（括号、「正在做」）留在外面。
 * 控制台显示不可信的文字有统一的组件时（#707 的 `UntrustedText`，还会把看不见的字符写出来）换成它：换这一个文件就够。
 */
export function PeerText({ children }: { children: string }) {
	return <bdi>{children}</bdi>;
}

/** 别人的文字单独占一格时放在那一格上的属性：方向跟着文字走，和 {@link PeerText} 一样的隔离。 */
export const peerBlockProps = { dir: "auto" } as const;
