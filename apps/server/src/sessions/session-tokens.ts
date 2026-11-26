// 会话令牌的签发、吊销和第二道打码（ADR 0029「凭据」，规格 #547）。
//
// 会话令牌是助手在工作台上执行 `sfly` 命令时用的凭据：代发起人（会话的 `created_by_user_id`）、限会话所在的项目、属于一个会话，
// 范围是读、运行、编辑、会话构建（`SESSION_TOKEN_SCOPES`，发布和管理要人，访问检查里和发起人此刻的角色取交集）。**一轮一枚**：
// 原值不能存（库里只有哈希），控制面会重启，而模型只在一轮之内用它；一轮一枚把暴露的时间限在一轮之内。
//
// **签发和吊销各只在一处**，都在调用方的事务里（这个文件的 {@link issueSessionToken}、{@link revokeSessionTokens}），
// 和「这一轮开始」「这一轮结束」「会话结束」的状态变化在同一个事务里提交：
// - 签发：每一轮开始的那一步（建会话、对空闲的会话发话、排队的会话轮到它，都在 `SessionStore`），同时吊销这个会话上一枚还有效的；
// - 吊销：这一轮以任何结局结束（助手服务带回的 `turn_end`，控制面自己补写的结局：停止等不到、助手服务重启、连不上、兜底的中断），
//   和会话结束时（`SessionStore.#insert`、`SessionStore.end`）。**不在控制面启动时一刀切吊销所有会话令牌**：控制面重启时
//   助手服务那边的一轮可能还在跑，重连之后补事件、看到 `turn_end` 再吊销。
// - 兜底：令牌带 `expires_at`，是这一轮的硬上限再加余量（{@link SESSION_TOKEN_TTL_MS}）：控制面在一轮中间崩了、没看到结局时，
//   令牌也不会一直有效。
//
// 原值只出现在 {@link issueSessionToken} 的返回值里：交给 `commandEnv`（`./command-env.ts`）放进 `secret_env`，随 `prompt` 命令
// 发给助手服务；控制面不落库、不写日志（这个文件里没有任何日志输出）。
import { randomBytes, randomUUID } from "node:crypto";
import {
	ASSISTANT_STOP_WAIT_MS,
	ASSISTANT_TURN_MAX_MS,
	nameProblem,
	SECRET_MASK,
	TOKEN_PREFIXES,
} from "@sfly/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hashCredential } from "../auth/credential-hash.js";
import { SESSION_TOKEN_SCOPES } from "../auth/scopes.js";
import type { Tx } from "../db/database.js";
import { apiTokens, type sessions } from "../db/schema.js";

/** 令牌原值里随机部分的字节数：24 字节（192 位），十六进制 48 个字符，和别的令牌一样。 */
const SECRET_BYTES = 24;
/** 展示用的前缀长度：种类前缀（9 个字符）加原值开头的 4 个字符（和 `TokenService` 一样）。 */
const PREFIX_LENGTH = 13;

/**
 * 令牌在一轮的硬上限之外多留的余量（毫秒）：一轮从控制面签发令牌到助手服务开始计时之间有交接和 pi 的冷启动，
 * 到了上限还要最多 {@link ASSISTANT_STOP_WAIT_MS} 才收尾；余量只为让令牌在正常的一轮里不会先过期，
 * 过了它就是兜底该起作用的时候（控制面没有看到这一轮的结局）。
 */
export const SESSION_TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** 一枚会话令牌的有效期（毫秒）：一轮最长的时间 + 停止一轮最晚的时间 + 余量。 */
export const SESSION_TOKEN_TTL_MS =
	ASSISTANT_TURN_MAX_MS + ASSISTANT_STOP_WAIT_MS + SESSION_TOKEN_MARGIN_MS;

type SessionFields = Pick<
	typeof sessions.$inferSelect,
	"id" | "projectId" | "title" | "createdByUserId"
>;

/**
 * 令牌的名称：「会话：<会话标题>」（「经 …」记它，运行和场景版本上显示它）。标题带着名称不允许的字符（会让文字倒着显示、换行的）
 * 时换成会话 ID 的前 8 位：标题是用户说的第一句话截的，这个名称会出现在别人的命令行和页面上。
 */
export function sessionTokenName(session: Pick<SessionFields, "id" | "title">): string {
	const name = `会话：${session.title}`;
	return nameProblem(name) === undefined ? name : `会话：${session.id.slice(0, 8)}`;
}

/** 签发的结果：原值（只在这里出现一次），和这次一并吊销的上一枚（通知打开着的事件流）。 */
export interface IssuedSessionToken {
	token: string;
	revoked: string[];
}

/**
 * 为会话的这一轮签发一枚令牌（在这一轮开始的事务里）：先吊销这个会话上一枚还有效的，再插入新的。会话没有发起人的用户
 * （建于登录之前）时签发不了，返回 undefined——调用方不开始这一轮。
 */
export async function issueSessionToken(
	tx: Tx,
	session: SessionFields,
	now: Date,
): Promise<IssuedSessionToken | undefined> {
	if (session.createdByUserId === null) return undefined;
	const revoked = await revokeSessionTokens(tx, session.id, now);
	const token = `${TOKEN_PREFIXES.session}${randomBytes(SECRET_BYTES).toString("hex")}`;
	await tx.insert(apiTokens).values({
		id: randomUUID(),
		kind: "session",
		name: sessionTokenName(session),
		prefix: token.slice(0, PREFIX_LENGTH),
		tokenHash: hashCredential(token),
		userId: session.createdByUserId,
		projectId: session.projectId,
		sessionId: session.id,
		scopes: [...SESSION_TOKEN_SCOPES],
		createdAt: now,
		expiresAt: new Date(now.getTime() + SESSION_TOKEN_TTL_MS),
	});
	return { token, revoked };
}

/**
 * 吊销这个会话还有效的令牌（在这一轮结束、会话结束的事务里）；返回刚吊销的令牌 ID（没有有效的就是空的：重复调用无害）。
 * 只记第一次吊销的时间。令牌只吊销、不删除：「经 …」按令牌的名称记在运行和场景版本上。
 */
export async function revokeSessionTokens(tx: Tx, sessionId: string, now: Date): Promise<string[]> {
	const revoked = await tx
		.update(apiTokens)
		.set({ revokedAt: now })
		.where(
			and(
				eq(apiTokens.kind, "session"),
				eq(apiTokens.sessionId, sessionId),
				isNull(apiTokens.revokedAt),
			),
		)
		.returning({ id: apiTokens.id });
	return revoked.map((row) => row.id);
}

/**
 * 控制面收到助手服务的事件之后、写进 `session_events` 和推送之前，把里面的会话令牌换成掩码。这是**第二道**：第一道在助手服务
 * （`apps/assistant/src/redact.ts`），按这一轮令牌的原值打码；这里按**令牌的格式**认——`sfly_ses_` 加后面整段令牌字符
 * （字母、数字、`_`、`-`）——不管它是不是这一轮的、是不是助手服务认得的写法。否则项目里只有「读」的成员能从会话页上抄到令牌，
 * 在这一轮里以发起人的范围写东西。
 *
 * **和 #529「只看完整出现」的规矩不冲突**：这里认的是格式，不是某个 secret 值的部分匹配——文字里有没有 `sfly_ses_` 加令牌字符，
 * 只取决于文字本身，和哪个令牌是真的无关，不会成为试出令牌的办法。前缀后面至少要有一个令牌字符（文档里单独写的 `sfly_ses_`
 * 前缀不打码）。宁可多打码：前缀后面连着的字母数字，不论多长都是令牌的一部分。
 * **做不到的（已知的边界，`session-tokens.test.ts` 的「已知边界」断言它们现在的样子）**：令牌被拆在两条增量里
 * （`assistant_delta`、`tool_output`）时每条里都认不出完整的格式，那是第一道的事（助手服务的流式打码留尾巴，拼起来再认）；
 * 编码过的（base64、大小写改过、字符之间插了空格、shell 引号拼接等）不认；**被换行或空白拆开的**（`fold -w 10`：令牌字符到换行为止，
 * 前半截换成掩码、后半截原样留着）、**被 ANSI 转义序列夹住的**（`sfly_ses_\x1b[0m…`，序列不是令牌字符，前缀后面没有令牌字符或
 * 到序列为止）不认——这几种要模型特意把原值拆开或加颜色才会出现，和编码过的是一类，靠会话令牌的范围（读、运行、编辑、会话构建，
 * 不含发布和管理）和一轮结束就吊销兜底；多认一种写法（跨空白继续认十六进制字符）会把普通文字也打成掩码，没有做。
 *
 * 处理 JSON 值里的每一个字符串（对象的键不处理）；没有令牌时原样返回同一个值。
 */
export function maskSessionTokens<T>(value: T): T {
	return walk(value) as T;
}

const SESSION_TOKEN_IN_TEXT = new RegExp(`${TOKEN_PREFIXES.session}[A-Za-z0-9_-]+`, "g");

function walk(value: unknown): unknown {
	if (typeof value === "string") {
		return value.includes(TOKEN_PREFIXES.session)
			? value.replace(SESSION_TOKEN_IN_TEXT, SECRET_MASK)
			: value;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const items = value.map((item) => {
			const masked = walk(item);
			if (masked !== item) changed = true;
			return masked;
		});
		return changed ? items : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const entries = Object.entries(value).map(([key, item]) => {
			const masked = walk(item);
			if (masked !== item) changed = true;
			return [key, masked] as const;
		});
		return changed ? Object.fromEntries(entries) : value;
	}
	return value;
}
