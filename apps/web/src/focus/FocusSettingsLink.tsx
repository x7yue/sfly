import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { FOCUS } from "#/lib/copy";

/**
 * 去场景设置「关注项」页的链接（画布路由的 `?settings=focus`）：运行监控的概览和控制台运行块的读数区标题行右侧。
 * 场景设了关注项是「调整关注项」，没设是「设置关注项」。
 */
export function FocusSettingsLink({
	orchestrationId,
	configured,
}: {
	orchestrationId: string;
	configured: boolean;
}) {
	return (
		<Link
			to="/orchestrations/$id"
			params={{ id: orchestrationId }}
			search={{ settings: "focus" }}
			className="inline-flex flex-none items-center gap-1.5 rounded-sm text-xs text-fg-2 hover:text-fg-1"
		>
			<EyeIcon aria-hidden="true" className="size-3.5" />
			{FOCUS.settingsLink(configured)}
		</Link>
	);
}
