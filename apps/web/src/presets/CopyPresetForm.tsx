import { PresetName, type PresetView, presetsApi } from "@sfly/schema";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { TERM } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import {
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useInvalidatePresets } from "./invalidate";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 复制运行预设：取一个新名称，说明和预设参数（包括 secret 的值）由控制面原样复制。管理对话框里的一屏。 */
export function CopyPresetForm({
	orchestrationId,
	preset,
	onCancel,
	onCopied,
}: {
	orchestrationId: string;
	preset: PresetView;
	onCancel: () => void;
	onCopied: () => void;
}) {
	const invalidate = useInvalidatePresets();
	const nameInput = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(`${preset.name} 副本`);
	const [submitted, setSubmitted] = useState(false);
	useEffect(() => {
		nameInput.current?.select();
	}, []);
	const copy = useMutation({
		mutationFn: (value: string) =>
			callApi(presetsApi.copy, {
				params: { id: orchestrationId, presetId: preset.id },
				body: { name: value },
			}),
		onSuccess: async (copied) => {
			notify.success(`已复制为运行预设「${copied.name}」`);
			await invalidate();
			onCopied();
		},
	});
	const parsed = PresetName.safeParse(name);
	const nameError = submitted && !parsed.success ? parsed.error.issues[0]?.message : undefined;

	return (
		<form
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				setSubmitted(true);
				copy.reset();
				if (!parsed.success) nameInput.current?.focus();
				else copy.mutate(parsed.data);
			}}
		>
			<DialogHeader>
				<DialogTitle>复制{TERM.runPreset}</DialogTitle>
				<DialogDescription>
					复制「{preset.name}」：说明和预设参数（包括 secret
					参数的值）原样复制，名称在场景内不能重复。 复制之后可以再编辑，改几个值。
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<FormField label="新名称" required error={nameError}>
					{(control) => (
						<Input
							{...control}
							ref={nameInput}
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					)}
				</FormField>
				{copy.isError && <FormAlert>{errorText(copy.error)}</FormAlert>}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onCancel}>
					取消
				</Button>
				<Button type="submit" variant="primary" disabled={copy.isPending}>
					复制
				</Button>
			</DialogFooter>
		</form>
	);
}
