import { domainKey, sessionsApi } from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { callApi } from "#/lib/api";
import { SESSION } from "#/lib/copy";
import { errorText } from "#/lib/format";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-field";

/** 结束会话的请求的键：正在结束时（请求在路上）输入框同样不可用（`useIsMutating` 按它数）。 */
export const endMutationKey = (id: string) => ["sessions", "end", id] as const;

/**
 * 顶栏的「结束会话」：点了先确认，说明后果——在做的一轮会停下，排着的话会撤掉，结束之后不能再说话；工作区、提交、场景版本和运行都留着。
 * 确认后请求在路上时（最长等到这一轮停下，控制面最多等 23 秒）按钮写「正在结束…」，确认框不关；成功后关掉确认框，状态由事件流里的
 * `session_ended` 推进。失败时留在确认框里写明原因（会话已经没有了的 404 交给 `onGone`）。
 */
export function EndSession({ id, onGone }: { id: string; onGone: (error: unknown) => boolean }) {
	const [open, setOpen] = useState(false);
	const client = useQueryClient();
	const end = useMutation({
		mutationKey: endMutationKey(id),
		mutationFn: () => callApi(sessionsApi.end, { params: { id } }),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: domainKey(sessionsApi.list) });
			setOpen(false);
		},
		onError: (error) => {
			if (onGone(error)) setOpen(false);
		},
	});
	// 每次打开确认框都不带着上一次的失败。
	useEffect(() => {
		if (open) end.reset();
	}, [open, end.reset]);
	return (
		<>
			<Button
				size="sm"
				variant="ghost"
				title={SESSION.page.endTitle}
				disabled={end.isPending}
				onClick={() => setOpen(true)}
			>
				{end.isPending ? SESSION.page.ending2 : SESSION.page.end}
			</Button>
			<Dialog open={open} onOpenChange={(next) => !end.isPending && setOpen(next)}>
				<DialogContent className="w-[460px]" showCloseButton={!end.isPending}>
					<DialogHeader>
						<DialogTitle>{SESSION.page.endDialogTitle}</DialogTitle>
						<DialogDescription>{SESSION.page.endDialogBody}</DialogDescription>
					</DialogHeader>
					{end.isError && (
						<FormAlert>{`${SESSION.page.endFailed}：${errorText(end.error)}`}</FormAlert>
					)}
					<DialogFooter>
						<Button variant="ghost" disabled={end.isPending} onClick={() => setOpen(false)}>
							{SESSION.page.endCancel}
						</Button>
						<Button variant="danger-solid" disabled={end.isPending} onClick={() => end.mutate()}>
							{end.isPending ? SESSION.page.ending2 : SESSION.page.endConfirm}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
