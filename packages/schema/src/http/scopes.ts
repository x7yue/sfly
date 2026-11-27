/**
 * 范围（ADR 0029 的范围表）：检查只看范围，不看角色名；以后加「只能触发运行」这类角色，只是多一组范围。
 * 控制面的访问检查、控制台的令牌页和 `CurrentUser.scopes`（页面按它决定显示哪些操作）都从这里取。
 * 令牌的接口契约（`./tokens.ts`）再导出它们，原来从那里取的不用改。
 */
export const SCOPES = ["read", "run", "edit", "session_build", "publish", "manage"] as const;
export type Scope = (typeof SCOPES)[number];

/** 范围的中文名（GLOSSARY「令牌」里的词）：写进拒绝的说明，控制台的令牌页也显示它。 */
export const SCOPE_LABELS = {
	read: "读",
	run: "运行",
	edit: "编辑",
	session_build: "会话构建",
	publish: "发布",
	manage: "管理",
} as const satisfies Record<Scope, string>;
