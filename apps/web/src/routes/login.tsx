import { authApi } from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AuthLink, AuthPage } from "#/components/account/AuthPage";
import { safeRedirect } from "#/components/account/redirect";
import { ApiError, apiQuery, callApi } from "#/lib/api";
import { setCurrentUser, useIdentity } from "#/lib/identity";
import { Button } from "@/components/ui/button";
import { FormAlert, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/** 登录页（ADR 0029）：登录名和密码。登录成功后回到 `redirect` 指的本站路径，没有就回首页。 */
export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
		typeof search.redirect === "string" ? { redirect: search.redirect } : {},
	staticData: { crumb: "登录" },
	component: LoginPage,
});

const errorText = (error: unknown): string => {
	if (error instanceof ApiError) {
		if (error.status === 429) return error.message;
		if (error.code === "invalid_credentials") return "登录名或密码不对";
	}
	return error instanceof Error ? error.message : String(error);
};

function LoginPage() {
	const { redirect } = Route.useSearch();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const identity = useIdentity();
	const status = useQuery({ ...apiQuery(authApi.status), retry: false });
	const [loginName, setLoginName] = useState("");
	const [password, setPassword] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const nameInput = useRef<HTMLInputElement>(null);
	const passwordInput = useRef<HTMLInputElement>(null);

	// 已经登录着：不用再登录，回到要去的地方。
	useEffect(() => {
		if (identity.status === "user") void navigate({ to: safeRedirect(redirect), replace: true });
	}, [identity, navigate, redirect]);

	const nameProblem = loginName.trim() === "" ? "填写登录名" : undefined;
	const passwordProblem = password === "" ? "填写密码" : undefined;

	return (
		<AuthPage
			title="登录"
			description="用你的账号登录 sfly。"
			footer={
				status.data?.setup_required ? (
					<>
						还没有任何用户：<AuthLink to="/setup">用初始化码创建第一个管理员</AuthLink>
					</>
				) : undefined
			}
		>
			<form
				noValidate
				className="flex flex-col gap-3"
				onSubmit={async (e) => {
					e.preventDefault();
					setSubmitted(true);
					if (nameProblem) return nameInput.current?.focus();
					if (passwordProblem) return passwordInput.current?.focus();
					setPending(true);
					setError(undefined);
					try {
						const user = await callApi(authApi.login, {
							body: { login_name: loginName.trim(), password },
						});
						setCurrentUser(user);
						await queryClient.invalidateQueries();
						void navigate({ to: safeRedirect(redirect), replace: true });
					} catch (failure) {
						setError(errorText(failure));
						// 密码清空重填：先把「已经提交过」撤掉，不然空的密码框立刻显示「填写密码」，和服务端的错误叠在一起。
						setPassword("");
						setSubmitted(false);
						passwordInput.current?.focus();
					} finally {
						setPending(false);
					}
				}}
			>
				<FormField label="登录名" required error={submitted ? nameProblem : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={nameInput}
							value={loginName}
							onChange={(e) => setLoginName(e.target.value)}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
							autoFocus
						/>
					)}
				</FormField>
				<FormField label="密码" required error={submitted ? passwordProblem : undefined}>
					{(control) => (
						<Input
							{...control}
							ref={passwordInput}
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="current-password"
						/>
					)}
				</FormField>
				{error && <FormAlert>{error}</FormAlert>}
				<Button type="submit" variant="primary" disabled={pending}>
					登录
				</Button>
			</form>
		</AuthPage>
	);
}
