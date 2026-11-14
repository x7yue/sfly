import { useEffect, useRef, useSyncExternalStore } from "react";
import { dialogOpen, isEditable } from "#/lib/focus";
import {
	type PaletteShortcut,
	SHORTCUTS,
	type ShortcutGroup,
	type ShortcutId,
	ShortcutMatcher,
} from "#/lib/shortcuts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Keys } from "./page";

/**
 * 快捷键绑定（注册表见 #/lib/shortcuts）：
 *
 *   useShortcut("go-agents", () => navigate({ to: "/agents" }));
 *
 * 同一个快捷键被多处绑定时，最后挂载的生效（例如全屏页覆盖全局行为），卸载后恢复上一个。
 * `enabled` 为 false（或 id 传 null）时不绑定：键不被拦截，登记了 `palette` 的快捷键也不出现在命令面板里。
 * 全局只有一个 keydown 监听（ShortcutListener，挂在根路由），只匹配当前绑定了处理函数的快捷键。
 */

type Handler = () => void;
const handlers = new Map<ShortcutId, Handler[]>();

const isBound = (id: ShortcutId) => (handlers.get(id)?.length ?? 0) > 0;

const bindingListeners = new Set<() => void>();
let paletteCommands: readonly PaletteShortcut[] = [];

function bindingsChanged() {
	paletteCommands = SHORTCUTS.filter((s): s is PaletteShortcut => "palette" in s && isBound(s.id));
	for (const listener of bindingListeners) listener();
}

export function useShortcut(id: ShortcutId | null, handler: Handler, enabled = true) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (id === null || !enabled) return;
		const entry: Handler = () => ref.current();
		handlers.set(id, [...(handlers.get(id) ?? []), entry]);
		bindingsChanged();
		return () => {
			handlers.set(
				id,
				(handlers.get(id) ?? []).filter((h) => h !== entry),
			);
			bindingsChanged();
		};
	}, [id, enabled]);
}

/** 当前页面绑定了处理函数、并且登记了 `palette` 的快捷键（注册表顺序）：命令面板的「当前页面」分组。 */
export function usePaletteCommands(): readonly PaletteShortcut[] {
	return useSyncExternalStore(
		(listener) => {
			bindingListeners.add(listener);
			return () => bindingListeners.delete(listener);
		},
		() => paletteCommands,
		() => paletteCommands,
	);
}

/** 执行快捷键的处理函数（命令面板的命令）：与按键分发同一个规则，最后挂载的生效；没有绑定时什么也不做。 */
export function runShortcut(id: ShortcutId) {
	handlers.get(id)?.at(-1)?.();
}

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
					inDialog: dialogOpen(),
				},
				performance.now(),
				isBound,
			);
			if (!id) return;
			event.preventDefault();
			runShortcut(id);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
	return null;
}

const GROUPS: ShortcutGroup[] = ["全局", "编排画布", "运行监控", "列表页"];

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
								<h4 className="mt-1 mb-1 text-xs font-semibold text-fg-3">{group}</h4>
								<dl className="m-0 grid grid-cols-3 gap-x-6">
									{items.map((s) => (
										<div
											key={s.id}
											className="flex items-center justify-between border-b border-border-soft py-1.25 text-sm"
										>
											<dt>{s.label}</dt>
											<dd className="m-0">
												<Keys shortcut={s.id} />
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
