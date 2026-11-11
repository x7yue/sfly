import type { AgentEndpointView } from "@sfly/schema";
import type { AgentInfo } from "../db/schema.js";

/** 不监听端口的旧版本 Agent：能力不能被其它 Agent 调用的原因。 */
export const OLD_AGENT_UNAVAILABLE = "Agent 版本过旧，不监听供其它 Agent 连接的端口";

/**
 * 其它 Agent 连接这台 Agent 用的地址（ADR 0019）：对外地址取安装时显式配置的，没有配置时取控制面看到的连接来源地址。
 * Agent 页显示它；派发任务时据此把被引用的 Agent 的地址和端口随任务下发。
 */
export function agentEndpoint(info: Pick<AgentInfo, "peer" | "source_address">): AgentEndpointView {
	const configured = info.peer?.public_address;
	return {
		address: configured || (info.source_address ?? ""),
		address_source: configured ? "configured" : "connection",
		port: info.peer?.port ?? null,
		unavailable_reason: info.peer ? info.peer.listen_error || null : OLD_AGENT_UNAVAILABLE,
	};
}

/**
 * 连接来源地址（Node 的 `socket.remoteAddress`）：IPv4 连到双栈监听时是 `::ffff:10.0.0.5` 这样的映射地址，
 * 还原成 IPv4 写法。
 */
export function sourceAddress(remoteAddress: string | undefined): string {
	if (!remoteAddress) return "";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(remoteAddress);
	return mapped?.[1] ?? remoteAddress;
}
