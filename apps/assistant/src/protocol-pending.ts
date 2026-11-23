import { z } from "zod";

/**
 * #597 加进协议（`@sfly/schema` 的 assistant-protocol.ts）的两样，在它合入之前先放在这里，名字和它一样；
 * 合入之后删掉这个文件，改成从 `@sfly/schema` 导入。
 */

/** `POST /sessions/:id/abort` 的请求体：要结束的那一轮（和 `prompt` 里的 `turn` 是同一个）。 */
export const AbortCommandBody = z.object({ turn: z.int().min(1) });
export type AbortCommandBody = z.infer<typeof AbortCommandBody>;

/** 停止一轮时等 pi 自己退出的宽限（毫秒），超过就 SIGKILL；控制面等停止的时间引用同一个数。 */
export const ASSISTANT_PROCESS_KILL_GRACE_MS = 10_000;
