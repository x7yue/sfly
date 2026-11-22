// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { RUN_STATE_REFERENCE } from "@sfly/orchestration";
import { BracesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FieldControl } from "./fields";

/**
 * 「运行状态」类型（`sfly.RunState`，ADR 0031）的输入还没接入：一个按钮，点一下填上 `${{ run.state }}`。
 * 这种输入只有这一个合法的值，所以不用选、不用写；接入后显示为引用标签（ReferencePicker 的 ReferenceChip），
 * 点 × 回到这里。必填的没接入时，字段下面有静态检查的警告；可选的（`RunState | None`）不接入是允许的。
 */
export function RunStateConnect({
	control,
	name,
	onConnect,
}: {
	control?: FieldControl;
	/** 字段名，用在无障碍名称里。 */
	name: string;
	onConnect(): void;
}) {
	return (
		<Button
			id={control?.id}
			type="button"
			aria-describedby={control?.["aria-describedby"]}
			data-field-key={control?.["data-field-key"]}
			data-invalid={control?.["aria-invalid"]}
			aria-label={`在 ${name} 中接入运行状态`}
			title={`填入 ${RUN_STATE_REFERENCE}`}
			className="w-full justify-start text-fg-2 data-invalid:border-danger"
			onClick={onConnect}
		>
			<BracesIcon />
			接入运行状态
		</Button>
	);
}
