import { authApi, PASSWORD_MIN_LENGTH } from "@sfly/schema";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { ApiError, callApi } from "#/lib/api";
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
import { FormAlert, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/** 改自己的密码（ADR 0029）：要旧密码；改完之后别处的登录都注销，当前这个保留。 */
export function ChangePasswordDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [again, setAgain] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const oldInput = useRef<HTMLInputElement>(null);
	const newInput = useRef<HTMLInputElement>(null);
	const againInput = useRef<HTMLInputElement>(null);
	const change = useMutation({
		mutationFn: (body: { old_password: string; new_password: string }) =>
			callApi(authApi.changePassword, { body }),
		onSuccess: () => {
			onOpenChange(false);
			notify.success("密码已修改，其他地方的登录已退出");
		},
	});
	useEffect(() => {
		if (open) {
			setOldPassword("");
			setNewPassword("");
			setAgain("");
			setSubmitted(false);
			change.reset();
		}
	}, [open, change.reset]);

	const problems = {
		old: oldPassword === "" ? "填写旧密码" : undefined,
		new:
			newPassword.length < PASSWORD_MIN_LENGTH
				? `新密码至少 ${PASSWORD_MIN_LENGTH} 个字符`
				: undefined,
		again: again === newPassword ? undefined : "两次输入的新密码不一致",
	};
	const message =
		change.error instanceof ApiError && change.error.code === "wrong_password"
			? "旧密码不对"
			: change.error instanceof Error
				? change.error.message
				: undefined;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[400px]">
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						setSubmitted(true);
						if (problems.old) oldInput.current?.focus();
						else if (problems.new) newInput.current?.focus();
						else if (problems.again) againInput.current?.focus();
						else change.mutate({ old_password: oldPassword, new_password: newPassword });
					}}
				>
					<DialogHeader>
						<DialogTitle>修改密码</DialogTitle>
						<DialogDescription>
							改完之后，你在其他地方的登录会退出，当前这个保留。
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<FormField label="旧密码" required error={submitted ? problems.old : undefined}>
							{(control) => (
								<Input
									{...control}
									ref={oldInput}
									type="password"
									value={oldPassword}
									onChange={(e) => setOldPassword(e.target.value)}
									autoComplete="current-password"
									autoFocus
								/>
							)}
						</FormField>
						<FormField label="新密码" required error={submitted ? problems.new : undefined}>
							{(control) => (
								<Input
									{...control}
									ref={newInput}
									type="password"
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									autoComplete="new-password"
								/>
							)}
						</FormField>
						<FormField
							label="再输入一遍新密码"
							required
							error={submitted ? problems.again : undefined}
						>
							{(control) => (
								<Input
									{...control}
									ref={againInput}
									type="password"
									value={again}
									onChange={(e) => setAgain(e.target.value)}
									autoComplete="new-password"
								/>
							)}
						</FormField>
						{message && <FormAlert>{message}</FormAlert>}
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={change.isPending}>
							修改密码
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
