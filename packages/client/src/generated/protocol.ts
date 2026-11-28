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
 * 客户端标识请求头：API 客户端是 `sfly-client/<版本>`，命令行是 `sfly-cli/<版本>`，命令行检测到自己运行在
 * AI 编程助手里时再追加 ` agent/<AI 编程助手名称>`。只用于标注，不是鉴权；名称只收字母、数字和 `. _ + -`、最多 64 个字符
 * （`VIA_NAME_PATTERN`），有 `agent/` 但名称都不合格时存固定的占位值（`VIA_UNKNOWN`，不可能是合格的名称），显示成「未知」。
 */
export const CLIENT_HEADER = "x-sfly-client";

export const CONTROL_PLANE_TIME_EVENT = "time";
