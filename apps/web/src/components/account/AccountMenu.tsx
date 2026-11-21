import { authApi, type CurrentUser } from "@sfly/schema";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon, LogOutIcon } from "lucide-react";
import { useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { setCurrentUser } from "#/lib/identity";
import { Badge } from "@/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

/**
 * 顶栏右上角的账号菜单（登录之后代替昵称按钮）：显示名、登录名，修改密码、登出。
 * 登出之后回到登录页：没有登录的页面在 #494 之前仍然能用，但登出是用户明确要换身份。
 */
export function AccountMenu({ user }: { user: CurrentUser }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [passwordOpen, setPasswordOpen] = useState(false);

	const logout = async () => {
		try {
			await callApi(authApi.logout);
		} catch {
			// 登录已经失效（别处注销了）：当作登出了。
		}
		setCurrentUser(null);
		queryClient.clear();
		notify.info("已登出");
		await navigate({ to: "/login" });
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					title="账号"
					className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-fg-2 hover:bg-raised hover:text-fg-1 aria-expanded:bg-raised aria-expanded:text-fg-1"
				>
					<span
						aria-hidden
						className="grid size-6.5 flex-none place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
					>
						{[...user.display_name][0]?.toUpperCase()}
					</span>
					{user.display_name}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					<DropdownMenuGroup>
						<DropdownMenuLabel className="flex flex-col gap-0.5">
							<span className="flex items-center gap-1.5 text-fg-1">
								{user.display_name}
								{user.is_platform_admin && <Badge>平台管理员</Badge>}
							</span>
							<span className="font-mono text-xs font-normal text-fg-3">{user.login_name}</span>
						</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setPasswordOpen(true)}>
						<KeyRoundIcon />
						修改密码…
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void logout()}>
						<LogOutIcon />
						登出
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
		</>
	);
}
