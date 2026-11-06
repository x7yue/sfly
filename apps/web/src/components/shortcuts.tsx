import { useEffect, useRef } from "react";
import { SHORTCUTS, type ShortcutGroup, type ShortcutId, ShortcutMatcher } from "#/lib/shortcuts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Keys } from "./page";

/**
 * 快捷键绑定（注册表见 #/lib/shortcuts）：
 *
 *   useShortcut("go-agents", () => navigate({ to: "/agents" }));
 *
 * 同一个快捷键被多处绑定时，最后挂载的生效（例如全屏页覆盖全局行为），卸载后恢复上一个。
 * 全局只有一个 keydown 监听（ShortcutListener，挂在根路由）。
 */

type Handler = (event: KeyboardEvent) => void;
const handlers = new Map<ShortcutId, Handler[]>();

export function useShortcut(id: ShortcutId, handler: Handler, enabled = true) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!enabled) return;
		const entry: Handler = (event) => ref.current(event);
		const stack = handlers.get(id) ?? [];
		handlers.set(id, [...stack, entry]);
		return () => {
			handlers.set(
				id,
				(handlers.get(id) ?? []).filter((h) => h !== entry),
			);
		};
	}, [id, enabled]);
}

const isEditable = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const OPEN_DIALOG = '[role="dialog"][data-open], [role="alertdialog"][data-open]';

/** 全局快捷键监听；挂在根路由一次。 */
export function ShortcutListener() {
	useEffect(() => {
		const matcher = new ShortcutMatcher(SHORTCUTS);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.repeat || event.isComposing) return;
			const id = matcher.handle(
				{
					key: event.key,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					altKey: event.altKey,
					shiftKey: event.shiftKey,
					editable: isEditable(event.target),
					// 正在关闭（退场动画中）的弹窗不算：Base UI 只给打开着的弹窗加 data-open。
					inDialog: document.querySelector(OPEN_DIALOG) !== null,
				},
				performance.now(),
			);
			const handler = id ? handlers.get(id)?.at(-1) : undefined;
			if (!handler) return;
			event.preventDefault();
			handler(event);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
	return null;
}

const GROUPS: ShortcutGroup[] = ["全局", "编排画布", "运行监控"];

/** 快捷键面板（?）：内容全部来自注册表。 */
export function ShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[740px]">
				<DialogHeader>
					<DialogTitle>快捷键</DialogTitle>
				</DialogHeader>
				<div className="overflow-y-auto">
					{GROUPS.map((group) => {
						const items = SHORTCUTS.filter((s) => s.group === group);
						if (items.length === 0) return null;
						return (
							<section key={group} aria-label={group}>
								<h4 className="mt-1 mb-1 text-xs font-medium text-fg-3">{group}</h4>
								<dl className="m-0 grid grid-cols-3 gap-x-6">
									{items.map((s) => (
										<div
											key={s.id}
											className="flex items-center justify-between border-b border-border-soft py-1.25 text-sm"
										>
											<dt>{s.label}</dt>
											<dd className="m-0">
												<Keys keys={s.keys} />
											</dd>
										</div>
									))}
								</dl>
							</section>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
