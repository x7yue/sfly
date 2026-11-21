// 契约包里引用 pi 的类型：会话事件和助手服务协议的类型要自己定义，不能借 pi 的。
// @hit
import type { AgentEvent } from "@earendil-works/pi-coding-agent";

export type SessionEvent = AgentEvent;
