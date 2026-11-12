/**
 * 发起写操作的人：昵称，以及这次操作经哪个 AI 编程助手（没有时为 null）。
 * 两者都只是标注，不做校验、不做鉴权（ADR 0004）。
 */
export interface Actor {
	nickname: string;
	via: string | null;
}
