import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { useIdentity } from "#/lib/identity";
import { INLINE_LINK } from "#/lib/inline-link";
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
 * 昵称只用于显示（版本作者、运行触发人），不做鉴权。
 * 登录之后写操作的身份是登录的用户（显示名），昵称弹窗不再出现；登录页和初始化页上也不弹（先登录）。
 * 还没有登录的人（#494 之前仍然可以不登录使用）在弹窗里有「去登录」。
 */
export function NicknameDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const nickname = useNickname();
	const identity = useIdentity();
	const onAuthPage = useRouterState({
		select: (state) => ["/login", "/setup"].includes(state.location.pathname),
	});
	// 还不知道有没有登录时（页面刚打开）不弹：有登录 Cookie 的人不该闪一下昵称弹窗。
	const required = nickname === null && identity.status === "anonymous" && !onAuthPage;
	const visible = required || (open && identity.status !== "user");
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
						{identity.status === "anonymous" && (
							<Link
								to="/login"
								className={cn("mr-auto text-sm", INLINE_LINK)}
								onClick={() => onOpenChange(false)}
							>
								已有账号，去登录
							</Link>
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
