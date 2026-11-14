import type { OrchestrationNode } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { fieldLabel } from "./field-label";

const entry: OrchestrationNode = {
	id: "entry",
	kind: "entry",
	params: [
		{ name: "1st", type: "string", required: false, secret: false },
		{ name: "", type: "string", required: false, secret: false },
	],
};
const pkg: OrchestrationNode = {
	id: "fetch",
	kind: "package",
	package: "demo-checks",
	node: "http_check",
	always: false,
	inputs: {},
};

describe("字段错误的位置说明", () => {
	it("入口参数：参数名加第几个参数的哪一项", () => {
		expect(fieldLabel(entry, "params.0.name")).toBe("参数 1st（第 1 个）的名称");
		expect(fieldLabel(entry, "params.0.default")).toBe("参数 1st（第 1 个）的默认值");
		expect(fieldLabel(entry, "params.0.type")).toBe("参数 1st（第 1 个）的类型");
		expect(fieldLabel(entry, "params.0.description")).toBe("参数 1st（第 1 个）的说明");
	});

	it("节点的显示名称", () => {
		expect(fieldLabel(pkg, "display_name")).toBe("显示名称");
	});

	it("还没有名字的参数只说第几个", () => {
		expect(fieldLabel(entry, "params.1.name")).toBe("第 2 个参数的名称");
	});

	it("包节点的输入与执行设置用检查器里的字段名", () => {
		expect(fieldLabel(pkg, "inputs.steps")).toBe("输入 steps");
		expect(fieldLabel(pkg, "value.steps")).toBe("输入 steps");
		expect(fieldLabel(pkg, "timeout")).toBe("超时");
		expect(fieldLabel(pkg, "retries")).toBe("重试次数");
		expect(fieldLabel(pkg, "queue_timeout")).toBe("排队超时");
		expect(fieldLabel(pkg, "agent")).toBe("节点 Agent");
	});

	it("每种节点的备注字段都叫「备注」", () => {
		expect(fieldLabel(pkg, "note")).toBe("备注");
		expect(fieldLabel(entry, "note")).toBe("备注");
	});

	it("异步任务节点的映射是子流程参数", () => {
		const async: OrchestrationNode = { id: "dispatch", kind: "async", params: {} };
		expect(fieldLabel(async, "params.date")).toBe("子流程参数 date");
	});

	it("内置节点的字段", () => {
		const sleep: OrchestrationNode = { id: "wait", kind: "sleep", always: false, duration: "" };
		expect(fieldLabel(sleep, "duration")).toBe("等待时长");
		const timer: OrchestrationNode = {
			id: "at",
			kind: "timer",
			always: false,
			at: "",
			tz: "Asia/Shanghai",
		};
		expect(fieldLabel(timer, "at")).toBe("触发时刻");
		expect(fieldLabel(timer, "tz")).toBe("时区");
		const sub: OrchestrationNode = { id: "sub", kind: "subflow_entry", name: "", params: [] };
		expect(fieldLabel(sub, "name")).toBe("子流程名称");
		const stop: OrchestrationNode = { id: "stop", kind: "stop_subflow", always: false };
		expect(fieldLabel(stop, "subflow")).toBe("要停止的子流程");
		expect(fieldLabel(stop, "id")).toBe("节点 ID");
		const notify: OrchestrationNode = {
			id: "notify",
			kind: "feishu_notify",
			always: false,
			format: "text",
			text: "",
			at_all: false,
			title: "",
			color: "blue",
			markdown: "",
		};
		expect(fieldLabel(notify, "bot")).toBe("飞书机器人");
		expect(fieldLabel(notify, "text")).toBe("文本");
		expect(fieldLabel(notify, "at_all")).toBe("@所有人");
		expect(fieldLabel(notify, "format")).toBe("格式");
		expect(fieldLabel(notify, "title")).toBe("标题");
		expect(fieldLabel(notify, "color")).toBe("标题颜色");
		expect(fieldLabel(notify, "markdown")).toBe("正文");
		expect(fieldLabel(notify, "message")).toBe("原始消息");
		// 原始消息的 JSON 草稿（输入框里还不是合法 JSON）按字段名称说明，不说「输入 message」。
		expect(fieldLabel(notify, "value.message")).toBe("原始消息");
	});

	it("场景级字段", () => {
		expect(fieldLabel(undefined, "default_agent")).toBe("默认 Agent");
		expect(fieldLabel(undefined, "packages.demo-checks")).toBe("节点包 demo-checks 的版本");
		expect(fieldLabel(undefined, "edges.2.from")).toBe("第 3 条连线的起点");
		expect(fieldLabel(undefined, "edges.0.to")).toBe("第 1 条连线的终点");
	});

	it("认不出的路径原样显示，不丢信息", () => {
		expect(fieldLabel(pkg, "something.else")).toBe("something.else");
	});
});
