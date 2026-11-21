// 路由要场景文档就用 OrchestrationStore：给的是打码后的（规则允许的写法）。
export async function document(orchestrations: OrchestrationStore, id: string, number: number) {
	return (await orchestrations.getVersion(id, number))?.document;
}
