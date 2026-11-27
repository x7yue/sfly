import { createFileRoute, redirect } from "@tanstack/react-router";

/** 助手页原来在 `/sessions`，现在是首页（#553）：旧书签跳到首页。 */
export const Route = createFileRoute("/_shell/sessions/")({
	beforeLoad: () => {
		throw redirect({ to: "/", replace: true });
	},
});
