import { authApi, PASSWORD_MIN_LENGTH } from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AuthLink, AuthPage } from "#/components/account/AuthPage";
import { apiQuery, callApi } from "#/lib/api";
import { setCurrentUser } from "#/lib/identity";
import { Button } from "@/components/ui/button";
import { FormAlert, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/**
 * 初始化页（ADR 0029）：控制面启动时没有任何用户，就在日志里打印一次性的初始化码（也写在数据目录的 setup-code 文件里），
 * 用它建第一个平台管理员，并直接登录。已经有用户之后这个页只剩一句指路。
 */
export const Route = createFileRoute("/setup")({
	staticData: { crumb: "初始化" },
	component: SetupPage,
});

const LOGIN_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

function SetupPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const status = useQuery({ ...apiQuery(authApi.status), retry: false });
	const [code, setCode] = useState("");
	const [loginName, setLoginName] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [again, setAgain] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const refs = {
		code: useRef<HTMLInputElement>(null),
		loginName: useRef<HTMLInputElement>(null),
		displayName: useRef<HTMLInputElement>(null),
		password: useRef<HTMLInputElement>(null),
		again: useRef<HTMLInputElement>(null),
	};

	if (status.data && !status.data.setup_required) {
		return (
			<AuthPage
				title="已经初始化过了"
				description="这个控制面已经有用户，不需要再用初始化码。"
				footer={<AuthLink to="/login">去登录</AuthLink>}
			>
				<span />
			</AuthPage>
		);
	}

	const problems = {
		code: code.trim() === "" ? "填写初始化码" : undefined,
		loginName: LOGIN_NAME_PATTERN.test(loginName)
			? undefined
			: "登录名只能用小写字母、数字和下划线，长度 1–32 个字符",
		displayName: displayName.trim() === "" ? "填写显示名" : undefined,
		password:
			password.length < PASSWORD_MIN_LENGTH ? `密码至少 ${PASSWORD_MIN_LENGTH} 个字符` : undefined,
		again: again === password ? undefined : "两次输入的密码不一致",
	};
	const order = ["code", "loginName", "displayName", "password", "again"] as const;

	return (
		<AuthPage
			title="创建第一个管理员"
			description="控制面还没有任何用户。初始化码在控制面启动时打印在日志里，也写在数据目录的 setup-code 文件里。"
			footer={<AuthLink to="/login">已有账号，去登录</AuthLink>}
		>
			<form
				noValidate
				className="flex flex-col gap-3"
				onSubmit={async (e) => {
					e.preventDefault();
					setSubmitted(true);
					const first = order.find((key) => problems[key]);
					if (first) return refs[first].current?.focus();
					setPending(true);
					setError(undefined);
					try {
						const user = await callApi(authApi.setup, {
							body: {
								setup_code: code.trim(),
								login_name: loginName,
								display_name: displayName.trim(),
								password,
							},
						});
						setCurrentUser(user);
						await queryClient.invalidateQueries();
						void navigate({ to: "/", replace: true });
					} catch (failure) {
						setError(failure instanceof Error ? failure.message : String(failure));
					} finally {
						setPending(false);
					}
				}}
			>
				<FormField label="初始化码" required error={submitted ? problems.code : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={refs.code}
							value={code}
							onChange={(e) => setCode(e.target.value)}
							autoComplete="off"
							autoCapitalize="characters"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					)}
				</FormField>
				<FormField
					label="登录名"
					required
					// 错误已经把规则写出来了：出错时不再重复显示帮助。
					help={
						submitted && problems.loginName ? undefined : "小写字母、数字和下划线，1–32 个字符。"
					}
					error={submitted ? problems.loginName : undefined}
				>
					{(control) => (
						<Input
							{...control}
							ref={refs.loginName}
							value={loginName}
							onChange={(e) => setLoginName(e.target.value)}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
						/>
					)}
				</FormField>
				<FormField label="显示名" required error={submitted ? problems.displayName : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={refs.displayName}
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
							autoComplete="name"
							maxLength={64}
						/>
					)}
				</FormField>
				<FormField label="密码" required error={submitted ? problems.password : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={refs.password}
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="new-password"
						/>
					)}
				</FormField>
				<FormField label="再输入一遍密码" required error={submitted ? problems.again : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={refs.again}
							type="password"
							value={again}
							onChange={(e) => setAgain(e.target.value)}
							autoComplete="new-password"
						/>
					)}
				</FormField>
				{error && <FormAlert>{error}</FormAlert>}
				<Button type="submit" variant="primary" disabled={pending}>
					创建并登录
				</Button>
			</form>
		</AuthPage>
	);
}
