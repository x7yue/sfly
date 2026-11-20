// 项目的标识（ADR 0029）：项目是顶层租户，场景、运行、Agent、节点包、飞书机器人都属于一个项目。
// 存储层按项目查询的函数都要求传 `ProjectId`：品牌类型让「忘了传项目」和「把别的字符串当项目」都过不了编译。

declare const projectIdBrand: unique symbol;

/** 项目标识：小写字母、数字、连字符，不以连字符开头，最长 63 个字符（库里 `projects_id_format` 约束同一条规则）。 */
export type ProjectId = string & { readonly [projectIdBrand]: true };

/** 项目标识的写法；改这里时同步改库里的约束（`projects_id_format`，迁移里的 CHECK）。 */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 默认项目：迁移时建出，升级前的数据全部归它。 */
export const DEFAULT_PROJECT = "default" as ProjectId;

/** 公共项目：迁移时建出，放平台维护的节点包（标准节点包），任何凭据都能读，只有平台管理员能发布。 */
export const PUBLIC_PROJECT = "public" as ProjectId;

/**
 * 一个项目能读到哪些项目里的节点包：自己的，加上公共项目的（任何项目都能读、引用公共项目里的包，ADR 0029）。
 * 升级时标准节点包（`sfly-std`）的已发布版本移进公共项目，接口和 Agent 下载归档仍然要找得到它们，所以按项目读节点包
 * 都按这个范围；「先找本项目、再找公共项目」的优先顺序和重名的规则在 #501、#502。
 */
export const readableProjects = (project: ProjectId): ProjectId[] =>
	project === PUBLIC_PROJECT ? [PUBLIC_PROJECT] : [project, PUBLIC_PROJECT];

/** 路径参数、请求体里的项目标识；写法不对时返回 undefined（当作不存在）。 */
export function parseProjectId(value: string): ProjectId | undefined {
	return PROJECT_ID.test(value) ? (value as ProjectId) : undefined;
}
