// 544-B 第 6 题：一个把以 AEVAL-HANDLE 开头的输入「处理掉」的扩展（输入处理器返回 handled），看 steer 的回应。
// biome-ignore lint/suspicious/noExplicitAny: 探针容器里没有 pi 的类型。
export default function (pi: any) {
	pi.on("input", (event: { text: string }) =>
		event.text.startsWith("AEVAL-HANDLE") ? { action: "handled" } : { action: "continue" },
	);
}
