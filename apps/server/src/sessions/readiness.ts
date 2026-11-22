import type { Readiness } from "@sfly/schema";

/**
 * 助手此刻能不能用（`GET /projects/:project/sessions` 的就绪状态，#538 第 3.3 节）。
 *
 * 助手默认关闭：控制面没有配置助手服务时，会话的写接口返回 503 `assistant_not_configured`，读接口照常，
 * 就绪状态里写明原因——这是代码保证的开关，不是文档。和助手服务的连接（它的地址、共享密钥、工作台的 Agent，
 * 以及助手服务不通、工作台不在线时的原因）在第二个 PR 里接上；在那之前助手总是没有配置。
 */
export async function assistantReadiness(): Promise<Readiness> {
	return {
		ready: false,
		workbench: null,
		problems: [
			{
				kind: "assistant_not_configured",
				message:
					"控制面没有配置助手服务（SFLY_ASSISTANT_URL、SFLY_ASSISTANT_SECRET），助手没有开启",
			},
		],
	};
}
