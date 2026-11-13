import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * 通知容器（sonner）。只做深色主题，挂在应用根部一次（AppShell）；
 * 发通知用 `#/components/notify` 的 notify.success / warning / error，不直接调用 sonner。
 */
const Toaster = ({ ...props }: ToasterProps) => {
	return (
		<Sonner
			theme="dark"
			position="top-center"
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4 text-ok" />,
				info: <InfoIcon className="size-4 text-fg-2" />,
				warning: <TriangleAlertIcon className="size-4 text-warn" />,
				error: <OctagonXIcon className="size-4 text-danger-fg" />,
				loading: <Loader2Icon className="size-4 animate-spin text-fg-2" />,
			}}
			style={
				{
					"--normal-bg": "var(--raised-2)",
					"--normal-text": "var(--fg-1)",
					"--normal-border": "var(--border-strong)",
					"--border-radius": "var(--radius)",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "font-sans! text-sm! shadow-pop!",
					description: "text-xs! text-fg-2!",
					actionButton: "bg-raised! text-fg-1! border! border-border! hover:bg-raised-2!",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
