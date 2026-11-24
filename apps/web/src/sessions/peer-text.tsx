/**
 * 别人写的文字（会话的标题、发起人的昵称、用户的话、通知里引用的话）：放进 `<bdi>`，方向跟着文字自己走，一个名字里从右到左的
 * 字母不把周围的文案顺序带反。控制台显示不可信的文字有统一的组件时（#707 的 `UntrustedText`，还会把看不见的字符写出来）换成它：
 * 这里是会话页里的唯一出口，换一处就够。
 */
export function PeerText({ children }: { children: string }) {
	return <bdi>{children}</bdi>;
}
