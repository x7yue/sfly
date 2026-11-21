// 规则只管 apps/server/src/http/：运行读取自己的投影里用运行绑定的版本文档是它的职责，别处同样的写法不拦。
export function nodeNames(read: RunRead) {
	return read.version.document.nodes.map((node) => node.id);
}
