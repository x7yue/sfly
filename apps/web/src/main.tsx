import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LucideProvider } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { alignPulses } from "#/components/status";
import { refreshIdentity, setSessionExpiredHandler } from "#/lib/identity";
import { initMotionPause } from "#/lib/motion-pause";
import { createRouter } from "./router";
import "./styles/app.css";

// 纯 SPA（ADR 0006）：构建产物由控制面托管，API 与 SSE 走同源的 /api。
const router = createRouter();
const root = document.getElementById("app");
if (!root) throw new Error("missing #app");
alignPulses(document);
initMotionPause();
// 登录失效（空闲期限到了、被注销、被停用）：请求或事件流重连拿到 401 时，本来登录着的人回到登录页，
// 登录之后再回到现在这个页面；缓存里是登录期间的数据，一起清掉。
setSessionExpiredHandler(() => {
	const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	router.options.context.queryClient.clear();
	void router.navigate({ to: "/login", search: { redirect: here, expired: true }, replace: true });
});
// 问控制面现在是不是登录着（登录 Cookie 页面脚本读不到）：顶栏的账号菜单、昵称弹窗要用。
void refreshIdentity();

createRoot(root).render(
	<StrictMode>
		<LucideProvider strokeWidth={1.5} nonScalingStroke>
			<QueryClientProvider client={router.options.context.queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LucideProvider>
	</StrictMode>,
);
