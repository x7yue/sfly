import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { setNickname, useNickname } from "#/lib/nickname";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/**
 * 昵称弹窗。第一次打开页面（还没有昵称）时强制弹出、不能关闭；之后从顶栏或命令面板打开修改。
 * 昵称只用于显示（版本作者、运行触发人、在线编辑者），不做鉴权。
 */
export function NicknameDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const nickname = useNickname();
	const required = nickname === null;
	const visible = required || open;
	const [value, setValue] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (visible) {
			setValue(nickname ?? "");
			setSubmitted(false);
		}
	}, [visible, nickname]);
	const problem = value.trim() ? undefined : "填写昵称";

	return (
		<Dialog
			open={visible}
			onOpenChange={(next) => {
				if (!required) onOpenChange(next);
			}}
			disablePointerDismissal={required}
		>
			<DialogContent className="w-[400px]" showCloseButton={!required}>
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						setSubmitted(true);
						if (problem) {
							input.current?.focus();
							return;
						}
						const next = value.trim();
						setNickname(next);
						if (!required) notify.success(`昵称已改为 ${next}`);
						onOpenChange(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>{required ? "欢迎使用 sfly" : "修改昵称"}</DialogTitle>
						<DialogDescription>
							昵称会标记你保存的场景版本和触发的运行，只保存在这个浏览器里。
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<FormField label="昵称" required error={submitted ? problem : undefined}>
							{(control) => (
								<Input
									{...control}
									ref={input}
									value={value}
									onChange={(e) => setValue(e.target.value)}
									placeholder="昵称"
									maxLength={40}
								/>
							)}
						</FormField>
					</DialogBody>
					<DialogFooter>
						{!required && (
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								取消
							</Button>
						)}
						<Button type="submit" variant="primary">
							{required ? "开始使用" : "保存"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
