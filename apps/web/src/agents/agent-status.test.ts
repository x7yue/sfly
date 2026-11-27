import type { AgentView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { acceptsTasks, agentCounts, agentStatusView, authNotice, isDisabled } from "./agent-status";

const base: Pick<AgentView, "status" | "preparing_since" | "version_mismatch" | "disabled_at"> = {
	status: "online",
	preparing_since: null,
	version_mismatch: false,
	disabled_at: null,
};
const DISABLED = "2026-01-01T00:00:00.000Z";

describe("已停用的 Agent（#492）", () => {
	it("停用的 Agent 不接任务，哪怕连接还在线（停用到连接关掉之间有一瞬）；恢复之后照常", () => {
		expect(acceptsTasks(base)).toBe(true);
		expect(acceptsTasks({ ...base, disabled_at: DISABLED })).toBe(false);
		expect(acceptsTasks({ ...base, status: "offline", disabled_at: DISABLED })).toBe(false);
		expect(isDisabled({ disabled_at: DISABLED })).toBe(true);
		expect(isDisabled({ disabled_at: null })).toBe(false);
	});

	it("状态写「已停用」，不写「离线」，也不写在线", () => {
		const agent = {
			...base,
			info: {
				agent_version: "0.1.0",
				os: "linux",
				arch: "x86_64",
				slots: 4,
				installed_packages: [],
			},
			install: null,
			update: { state: "none", remaining_tasks: 0, reason: "" },
		} as unknown as AgentView;
		expect(agentStatusView({ ...agent, status: "offline", disabled_at: DISABLED }).label).toBe(
			"已停用",
		);
		expect(agentStatusView({ ...agent, disabled_at: DISABLED }).label).toBe("已停用");
		expect(agentStatusView({ ...agent, status: "offline" }).label).toBe("离线");
	});
});

describe("最近一次连接用的凭据的提示（#492）", () => {
	const AT = "2026-01-01T00:00:00.000Z";
	it("停用的 Agent 不写提示：它带什么凭据都连不上，「本版本内仍可连接」是假的；恢复之后再按最近一次连接写", () => {
		expect(authNotice({ auth_kind: "none", disabled_at: AT })).toBeNull();
		expect(authNotice({ auth_kind: "shared", disabled_at: AT })).toBeNull();
		expect(authNotice({ auth_kind: "agent", disabled_at: AT })).toBeNull();
		expect(authNotice({ auth_kind: "none", disabled_at: null })?.kind).toBe("none");
		expect(authNotice({ auth_kind: "shared", disabled_at: null })?.kind).toBe("shared");
	});

	it("共享令牌：提示换成这台 Agent 自己的凭据，不告警", () => {
		expect(authNotice({ auth_kind: "shared", disabled_at: null })).toEqual({
			kind: "shared",
			label: "用共享令牌连接",
			hint: "请换成这台 Agent 自己的凭据",
			severity: "info",
		});
	});

	it("没有凭据：告警本版本内仍可连接，下一个版本起拒绝", () => {
		expect(authNotice({ auth_kind: "none", disabled_at: null })).toEqual({
			kind: "none",
			label: "没有凭据",
			hint: "本版本内仍可连接，下一个版本起拒绝",
			severity: "warn",
		});
	});

	it("Agent 自己的凭据是该有的样子；没记过（升级之前连接的、没连过）的不写", () => {
		expect(authNotice({ auth_kind: "agent", disabled_at: null })).toBeNull();
		expect(authNotice({ auth_kind: null, disabled_at: null })).toBeNull();
	});
});

describe("在线和停用各有几台（#492）", () => {
	const online = { status: "online" as const, disabled_at: null };
	const offline = { status: "offline" as const, disabled_at: null };
	const stopped = { status: "offline" as const, disabled_at: DISABLED };
	const closing = { status: "online" as const, disabled_at: DISABLED };

	it("总数不含已停用的，在线也不含（停用到连接关掉之间还在线的那一瞬不算）", () => {
		expect(agentCounts([online, offline])).toEqual({ online: 1, enabled: 2, disabled: 0 });
		expect(agentCounts([online, offline, stopped])).toEqual({ online: 1, enabled: 2, disabled: 1 });
		expect(agentCounts([online, closing])).toEqual({ online: 1, enabled: 1, disabled: 1 });
		expect(agentCounts([stopped])).toEqual({ online: 0, enabled: 0, disabled: 1 });
		expect(agentCounts([])).toEqual({ online: 0, enabled: 0, disabled: 0 });
	});
});
