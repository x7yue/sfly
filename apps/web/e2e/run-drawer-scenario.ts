// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串

// 运行抽屉端到端测试与视觉回归共用的场景。

/** 入口参数：host（必填）、steps（数字，默认 3）、dry_run（布尔）、api_token（敏感，必填）。 */
export const PARAM_SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "host", type: "string", required: true },
				{ name: "steps", type: "number", default: 3 },
				{ name: "dry_run", type: "boolean", default: false },
				{ name: "api_token", type: "string", required: true, secret: true },
			],
		},
		{
			id: "ping",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			inputs: { host: "${{ params.host }}" },
		},
	],
	edges: [{ from: "entry", to: "ping", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};
