import { UntrustedText } from "#/components/untrusted-text";
import { errorText } from "#/lib/format";

/**
 * 接口的错误信息（`ApiError.message` 和别的 `Error`）写在页面上：**一律经 `UntrustedText`**（#699）。控制面自己写的句子里常拼着
 * Agent 报的原文（Agent 名、更新失败的原因、工作台不可用的原因），不逐条判断哪条里有别人的文字。
 * 弹窗里的错误用 `FormAlert`（它里面的字符串已经经过组件）、通知用 `notify`（同样），其余写在页面里的地方用这个：
 *
 *   无法加载：<ErrorMessage error={query.error} />
 */
export function ErrorMessage({ error }: { error: unknown }) {
	return <UntrustedText text={errorText(error)} mode="text" />;
}
