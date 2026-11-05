// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	dispatchTarget,
	type OrchestrationWarning,
	type PackageCatalog,
	referenceOptions,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import type { DocNode } from "./flow";
import { ReferenceInput } from "./ReferenceInput";

type AsyncNode = Extract<DocNode, { kind: "async" }>;

/** 映射值在输入框里的文本：字符串原样显示，其余常量按 JSON 显示。 */
const textOf = (value: unknown) =>
	value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

/**
 * 输入框文本 → 映射值。目标参数不是 string 时，不含引用的 JSON 字面量按常量保存（如 3、true、{"a":1}），
 * 整值引用按原类型传入；其余按字符串保存。
 */
function mappedValue(text: string, type: string): unknown {
	if (type === "string" || text.includes("${{")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** 异步任务节点：调度到的子流程，以及把主链的值映射为子流程参数（§4）。 */
export function AsyncSettings({
	id,
	node,
	doc,
	catalog,
	warnings,
	onChange,
	onLocate,
}: {
	id: string;
	node: AsyncNode;
	doc: OrchestrationDocument;
	catalog: PackageCatalog;
	warnings: OrchestrationWarning[];
	onChange(node: DocNode): void;
	onLocate?: (id: string) => void;
}) {
	const subflow = dispatchTarget(doc, id);
	const options = referenceOptions(doc, id, catalog);
	const setParam = (name: string, value: unknown) => {
		const params = { ...node.params };
		if (value === undefined || value === "") delete params[name];
		else params[name] = value;
		onChange({ ...node, params });
	};
	const warningsOf = (name: string) =>
		warnings.filter((w) => "input" in w && w.input === name).map((w) => w.message);

	if (!subflow) {
		return (
			<p className="sf-hint">
				从节点底部的 ◆ 调度端口拖一条连线到某个子流程入口节点的输入端口，再在这里映射子流程参数。
			</p>
		);
	}
	const declared = new Set(subflow.params.map((p) => p.name));
	const extra = Object.keys(node.params).filter((k) => !declared.has(k));
	return (
		<div className="space-y-3">
			<div className="sf-card flex items-center gap-2">
				<span className="text-[12.5px] text-[var(--sf-text-2)]">◆ 调度到</span>
				<code className="text-[var(--sf-violet)]">{subflow.id}</code>
				{onLocate && (
					<button
						type="button"
						className="sf-link ml-auto text-xs"
						onClick={() => onLocate(subflow.id)}
					>
						定位
					</button>
				)}
			</div>
			{subflow.params.length === 0 && (
				<p className="sf-hint">子流程入口 {subflow.id} 没有声明参数。</p>
			)}
			{subflow.params.map((p) => {
				const problems = warningsOf(p.name);
				return (
					<div key={p.name} className="sf-field">
						<span className="sf-label">
							<code>{p.name}</code>
							{p.required && <span className="text-[var(--sf-warn)]"> *</span>}
						</span>
						<div className="min-w-0">
							<ReferenceInput
								label={`子流程参数 ${p.name}`}
								value={textOf(node.params[p.name])}
								options={options}
								placeholder={
									p.default !== undefined
										? `默认 ${textOf(p.default)}`
										: `${p.type}${p.required ? "，必填" : ""}`
								}
								invalid={problems.length > 0}
								onChange={(text) =>
									setParam(p.name, text === "" ? undefined : mappedValue(text, p.type))
								}
							/>
							{problems.map((m) => (
								<p key={m} className="sf-err">
									{m}
								</p>
							))}
						</div>
					</div>
				);
			})}
			{extra.map((name) => (
				<div key={name} className="sf-warn-item flex items-center gap-2">
					<span>
						映射了子流程没有声明的参数 <code>{name}</code>
					</span>
					<button
						type="button"
						className="sf-link sf-link--danger ml-auto text-xs"
						onClick={() => setParam(name, undefined)}
					>
						移除
					</button>
				</div>
			))}
			<p className="sf-hint">
				值按值复制传入子流程。可以写常量，或引用本链的入口参数和本链上前面节点的输出（输入{" "}
				<code>{"${{"}</code>）；子流程只能看到这里传入的参数。
			</p>
		</div>
	);
}

/** 子流程入口节点：触发它的异步任务节点。 */
export function SubflowTrigger({
	id,
	doc,
	onLocate,
}: {
	id: string;
	doc: OrchestrationDocument;
	onLocate?: (id: string) => void;
}) {
	const triggers = doc.edges.filter((e) => e.kind === "dispatch" && e.to === id).map((e) => e.from);
	if (triggers.length === 0) {
		return (
			<p className="sf-hint">
				还没有异步任务节点触发这个子流程：从异步任务节点底部的 ◆ 调度端口连到这里左侧的输入端口。
			</p>
		);
	}
	return (
		<div className="space-y-2">
			{triggers.map((t) => (
				<div key={t} className="sf-card flex items-center gap-2">
					<span className="text-[12.5px] text-[var(--sf-text-2)]">由异步任务节点</span>
					<code>{t}</code>
					<span className="text-[12.5px] text-[var(--sf-text-2)]">触发</span>
					{onLocate && (
						<button type="button" className="sf-link ml-auto text-xs" onClick={() => onLocate(t)}>
							定位
						</button>
					)}
				</div>
			))}
			<p className="sf-hint">
				子流程看不到主链的数据，只能引用这里声明的参数和子流程上前面节点的输出。子流程失败不影响主链。
			</p>
		</div>
	);
}
