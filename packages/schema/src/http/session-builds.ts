import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 会话构建（GLOSSARY「会话构建」，ADR 0027 第 2 条、ADR 0029「会话构建和正式版本走两个接口」，#795）：助手开发中的节点包打成的、
 * 只属于这次会话的版本，经现有的派发和安装链路送到别的 Agent 上。版本号是 `<基础版本>+s<会话 ID 去掉连字符>.<序号>`
 * （{@link sessionBuildTag}），只有本会话的场景版本能锁定它；会话结束之后不能再引用，没有没结束的运行用它时由周期清理删掉。
 */

/** 路径里的会话 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
const IdParams = z.object({ id: z.string() });

/** 会话构建版本号里的本地标签：`s` 加会话 ID 去掉连字符的 32 位小写十六进制，`.` 加不带前导零的序号。 */
export const SESSION_BUILD_TAG = /^s[0-9a-f]{32}\.(0|[1-9][0-9]*)$/;

/** 这个会话的会话构建标签（不含序号）：`s` 加会话 ID 去掉连字符。 */
export const sessionBuildTag = (sessionId: string) =>
	`s${sessionId.replaceAll("-", "").toLowerCase()}`;

/** 版本号的本地标签（`+` 之后的部分）；没有时是 undefined。 */
export const localLabel = (version: string): string | undefined => {
	const plus = version.indexOf("+");
	return plus < 0 ? undefined : version.slice(plus + 1);
};

/** 版本号带着会话构建的标签（不论哪个会话的）。 */
export const hasSessionBuildTag = (version: string): boolean => {
	const label = localLabel(version);
	return label !== undefined && SESSION_BUILD_TAG.test(label);
};

/** 版本号带着这个会话的会话构建标签。 */
export const isSessionBuildOf = (version: string, sessionId: string): boolean =>
	hasSessionBuildTag(version) &&
	(localLabel(version) as string).startsWith(`${sessionBuildTag(sessionId)}.`);

/** 一个会话构建。 */
export const SessionBuildView = z.object({
	name: z.string(),
	version: z.string(),
	sha256: z.string(),
	size: z.number().int(),
	registered_at: Timestamp,
});

export type SessionBuildView = z.infer<typeof SessionBuildView>;

export const SessionBuildListResponse = z.object({
	/** 按登记时间从新到旧。 */
	builds: z.array(SessionBuildView),
});

export const sessionBuildsApi = {
	/**
	 * 登记会话构建：请求体是 `sfly build` 打出的 .sflypkg 原始字节（application/octet-stream，不在契约里），返回 201。
	 * 版本号要带这个会话的标签（{@link sessionBuildTag}）；会话已结束 409 `session_ended`；元信息不合法、标签不对 400
	 * `invalid_package`；`包名@版本` 已存在 409 `conflict`。会话令牌只能登记到自己的会话。
	 */
	register: endpoint({
		method: "POST",
		path: "/sessions/:id/builds",
		summary: "登记会话构建：请求体是 .sflypkg 归档的原始字节，版本号带这个会话的标签",
		effect: "write",
		resource: { kind: "session", target: { params: "id" } },
		creates: "session_build",
		client: false,
		key: ["session-builds", "register"],
		upload: true,
		params: IdParams,
		response: SessionBuildView,
	}),
	/** 这个会话登记的会话构建（已经回收的不在里面）。会话令牌只能列出自己的会话的。 */
	list: endpoint({
		method: "GET",
		path: "/sessions/:id/builds",
		summary: "列出这个会话登记的会话构建",
		effect: "read",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		key: ["session-builds", "list"],
		params: IdParams,
		response: SessionBuildListResponse,
	}),
};
