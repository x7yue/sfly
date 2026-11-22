/** Agent 管理页里一台 Agent 的机架在页面里的锚点（地址的 `#` 后面）：从别处链接到某台 Agent 时用。 */
export const agentAnchor = (name: string): string => `agent-${name}`;
