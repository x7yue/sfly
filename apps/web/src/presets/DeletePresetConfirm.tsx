import { type PresetView, presetsApi } from "@sfly/schema";
import { useMutation } from "@tanstack/react-query";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { Button } from "@/components/ui/button";
import {
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-field";
import { useInvalidatePresets } from "./invalidate";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 删除运行预设的确认。管理对话框里的一屏；已有运行上记下的预设名不受影响。 */
export function DeletePresetConfirm({
	orchestrationId,
	preset,
	onCancel,
	onDeleted,
}: {
	orchestrationId: string;
	preset: PresetView;
	onCancel: () => void;
	onDeleted: () => void;
}) {
	const invalidate = useInvalidatePresets();
	const remove = useMutation({
		mutationFn: () =>
			callApi(presetsApi.remove, { params: { id: orchestrationId, presetId: preset.id } }),
		onSuccess: async () => {
			notify.success(`已删除运行预设「${preset.name}」`);
			await invalidate();
			onDeleted();
		},
	});
	return (
		<>
			<DialogHeader>
				<DialogTitle>删除运行预设「{preset.name}」？</DialogTitle>
				<DialogDescription>
					删除后不能恢复，触发运行时也选不到它。已有运行上记下的预设名不受影响。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				{remove.isError && <FormAlert>删除失败：{errorText(remove.error)}</FormAlert>}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" autoFocus onClick={onCancel}>
					取消
				</Button>
				<Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
					删除
				</Button>
			</DialogFooter>
		</>
	);
}
