// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。

/**
 * 控制面时间（GLOSSARY「时间」，ADR 0018）：控制面把自己的当前时间带给页面，页面据此修正浏览器时间，
 * "已运行"等时长才不依赖浏览器时钟（apps/web/src/lib/control-plane-time.ts）。
 *
 * - 每个 HTTP 响应都带 `CONTROL_PLANE_TIME_HEADER` 响应头，值是 `Timestamp`。
 * - 每条 SSE 流在连上时和每次心跳都发一条 `CONTROL_PLANE_TIME_EVENT` 事件，data 是 `ControlPlaneTimeEvent`。
 *   它由控制面统一发送，不写进各个 `stream` 的 `events`。
 */
export const CONTROL_PLANE_TIME_HEADER = "x-sfly-time";

/**
 * 控制面版本：每个 HTTP 响应（含错误响应和 SSE 流）都带 `CONTROL_PLANE_VERSION_HEADER` 响应头，
 * 值是控制面的版本号（Agent、SDK 与控制面同版本，ADR 0010）。`sfly` 命令行据此在版本不一致时告警。
 */
export const CONTROL_PLANE_VERSION_HEADER = "x-sfly-version";

/**
 * 昵称请求头（ADR 0004：只用于显示，不做鉴权）。值按 encodeURIComponent 编码，这样中文昵称也能放进请求头。
 * 写操作必须带它，没有时控制面回复 400 `nickname_required`。
 */
export const NICKNAME_HEADER = "x-sfly-nickname";

/**
 * 客户端标识请求头：API 客户端是 `sfly-client/<版本>`，命令行是 `sfly-cli/<版本>`，命令行检测到自己运行在
 * AI 编程助手里时再追加 ` agent/<AI 编程助手名称>`。和昵称一样不做校验，只用于标注。
 */
export const CLIENT_HEADER = "x-sfly-client";

export const CONTROL_PLANE_TIME_EVENT = "time";
