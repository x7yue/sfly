import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PopoverClose } from "@/components/ui/popover";

/**
 * 添加节点菜单里与子流程有关的两个表单（AddNodeMenu）：新建子流程入口时填写名称；添加异步任务节点时
 * 可以勾选「同时新建子流程」（#187）。名称必填、场景内唯一（SEMANTICS §1.2）：空名称在提交时提示，重名随输入提示。
 *
 * `focusRef` 是表单打开时拿到焦点的元素的 ref（AddNodeMenu 借它记下打开菜单前的焦点，关闭时交还）。
 */

/** 名称有什么问题（为空、重名）；可以使用时返回 null。 */
type ProblemOf = (name: string) => string | null;
type FocusRef = (el: HTMLInputElement | null) => void;

function useSubflowName(problemOf: ProblemOf) {
	const [name, setName] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const problem = problemOf(name);
	return {
		name,
		setName,
		shown: submitted || name.trim() !== "" ? problem : null,
		/** 提交：名称可以使用时返回 true，否则显示原因。 */
		submit() {
			setSubmitted(true);
			return problem === null;
		},
	};
}

function SubflowNameField({
	inputRef,
	field,
}: {
	inputRef: React.Ref<HTMLInputElement>;
	field: ReturnType<typeof useSubflowName>;
}) {
	const inputId = useId();
	return (
		<>
			<label htmlFor={inputId} className="text-sm text-fg-2">
				子流程名称
			</label>
			<Input
				ref={inputRef}
				id={inputId}
				value={field.name}
				placeholder="例如 压测监控"
				aria-invalid={field.shown !== null || undefined}
				onChange={(e) => field.setName(e.target.value)}
			/>
			{field.shown && <p className="m-0 text-xs text-danger-fg">{field.shown}</p>}
			<p className="m-0 text-xs text-fg-3">场景内唯一；停止子流程节点按名称选择子流程。</p>
		</>
	);
}

/** 菜单底部的说明行：这次添加的节点接在哪、连什么线。 */
export function FormFooter({ children }: { children: ReactNode }) {
	return <p className="m-0 border-t border-border-soft px-3 py-2 text-xs text-fg-3">{children}</p>;
}

/**
 * 新建子流程：填写名称。从调度端口拖线时没有可以返回的节点列表（不给 `onBack`），按钮是关闭菜单的「取消」，
 * `footer` 写明调度连线从哪个节点连出。
 */
export function SubflowNameForm({
	focusRef,
	problemOf,
	footer,
	onBack,
	onCreate,
}: {
	focusRef: FocusRef;
	problemOf: ProblemOf;
	footer?: ReactNode;
	onBack?: () => void;
	onCreate(name: string): void;
}) {
	const field = useSubflowName(problemOf);
	return (
		<form
			aria-label="新建子流程"
			onSubmit={(e) => {
				e.preventDefault();
				if (field.submit()) onCreate(field.name);
			}}
		>
			<div className="flex flex-col gap-2 p-3">
				<SubflowNameField inputRef={focusRef} field={field} />
				<div className="flex justify-end gap-1.5">
					{onBack ? (
						<Button type="button" variant="ghost" size="sm" onClick={onBack}>
							返回
						</Button>
					) : (
						// 经菜单自己的关闭按钮关闭：焦点回到打开菜单前的位置。
						<PopoverClose render={<Button type="button" variant="ghost" size="sm" />}>
							取消
						</PopoverClose>
					)}
					<Button type="submit" size="sm">
						新建子流程
					</Button>
				</div>
			</div>
			{footer && <FormFooter>{footer}</FormFooter>}
		</form>
	);
}

/**
 * 添加异步任务节点：勾选「同时新建子流程」并填写名称时，一并新建子流程入口节点和调度连线（`onCreate` 带上名称）。
 * 打开时焦点在勾选框上，不勾选直接回车只添加异步任务节点；勾选后焦点移到名称输入框。
 */
export function AsyncForm({
	focusRef,
	problemOf,
	footer,
	onBack,
	onCreate,
}: {
	focusRef: FocusRef;
	problemOf: ProblemOf;
	footer: ReactNode;
	onBack(): void;
	onCreate(subflow?: string): void;
}) {
	const [withSubflow, setWithSubflow] = useState(false);
	const checkboxId = useId();
	const field = useSubflowName(problemOf);
	const nameInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (withSubflow) nameInput.current?.focus();
	}, [withSubflow]);
	return (
		<form
			aria-label="添加异步任务"
			onSubmit={(e) => {
				e.preventDefault();
				if (!withSubflow) onCreate();
				else if (field.submit()) onCreate(field.name);
			}}
		>
			<div className="flex flex-col gap-2 p-3">
				<label
					htmlFor={checkboxId}
					className="flex cursor-pointer items-center gap-2 text-sm text-fg-1"
				>
					<Checkbox
						id={checkboxId}
						ref={focusRef}
						checked={withSubflow}
						onChange={(e) => setWithSubflow(e.target.checked)}
						onKeyDown={(e) => {
							// 勾选框上按 Enter 也提交（浏览器不一定对勾选框做隐式提交）。
							if (e.key !== "Enter") return;
							e.preventDefault();
							e.currentTarget.form?.requestSubmit();
						}}
					/>
					同时新建子流程
				</label>
				<p className="m-0 text-xs text-fg-3">一并新建子流程入口节点和调度连线。</p>
				{withSubflow && <SubflowNameField inputRef={nameInput} field={field} />}
				<div className="flex justify-end gap-1.5">
					<Button type="button" variant="ghost" size="sm" onClick={onBack}>
						返回
					</Button>
					<Button type="submit" size="sm">
						添加
					</Button>
				</div>
			</div>
			<FormFooter>{footer}</FormFooter>
		</form>
	);
}
