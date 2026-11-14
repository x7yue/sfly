import { type NodeTypeIo, schemaDescription } from "@sfly/orchestration";

/**
 * 检查器「说明」标签页里节点类型的输出：「输出 | 说明」两列，说明是节点包用 `Doc` 写的；
 * 没写说明的输出（含旧版本的节点包）那一格留空，不提示缺失。
 */
export function NodeOutputs({ outputs }: { outputs: NodeTypeIo["outputs"] }) {
	return (
		<table aria-label="输出" className="mt-3 w-full border-collapse text-xs">
			<thead>
				<tr className="text-left text-fg-3">
					<th scope="col" className="w-px py-1 pr-3 font-normal whitespace-nowrap">
						输出
					</th>
					<th scope="col" className="py-1 font-normal">
						说明
					</th>
				</tr>
			</thead>
			<tbody>
				{Object.entries(outputs.properties).map(([name, schema]) => (
					<tr key={name} className="border-t border-border-soft align-baseline">
						<td className="py-1.5 pr-3 font-mono whitespace-nowrap text-fg-1">{name}</td>
						<td className="py-1.5 whitespace-pre-line text-fg-2 wrap-anywhere">
							{schemaDescription(schema)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
