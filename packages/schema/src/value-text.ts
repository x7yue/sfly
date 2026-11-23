/**
 * 错误说明里「实际是 …」后面的文字（节点的超时、排队超时不合格时，#576）：数字按 JavaScript 的 `Number#toString` 写，
 * 其余的按 JSON 写（字符串带引号：`"30"` 和 `30` 看得出区别，`null`、`true`、`[]` 照写）。
 * 命令行的本地检查（Python）写成一样的文字（sdk/python 的 `sfly.cli.value_text`），两端共用
 * testdata/node-timeout-value-cases.json。
 */
export const valueText = (value: unknown): string =>
	typeof value === "number" ? String(value) : (JSON.stringify(value) ?? String(value));
