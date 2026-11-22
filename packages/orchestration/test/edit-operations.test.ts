// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	EditOperation,
	type EditOperationInput,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	applyEditOperations,
	checkConnection,
	disconnectEdge,
	insertAfter,
	newPackageNode,
	type PackageCatalog,
	packageKey,
	removeNodes,
	similarNodeIds,
	uniqueNodeId,
} from "../src/index.js";

// 场景的局部编辑（#470）：一组操作按顺序作用在文档上，用的是画布的编辑函数；有一个不合法时整组不生效。

const doc = (): StoredOrchestrationDocument => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
		{
			id: "fetch_data",
			kind: "package",
			package: "http",
			node: "get",
			always: false,
			inputs: { url: "http://a.test" },
			display_name: "取数据",
			position: { x: 300, y: 0 },
		},
		{
			id: "report",
			kind: "package",
			package: "http",
			node: "get",
			always: false,
			inputs: { url: "http://b.test" },
			position: { x: 600, y: 0 },
		},
		{ id: "spawn", kind: "async", params: {}, position: { x: 300, y: 300 } },
		{ id: "sub", kind: "subflow_entry", name: "监控", params: [], position: { x: 600, y: 300 } },
	],
	edges: [
		{ from: "entry", to: "fetch_data", kind: "chain" },
		{ from: "fetch_data", to: "report", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
	],
	packages: { http: "1.0.0" },
	annotations: [
		{ id: "annotation_1", title: "取数据", nodes: ["fetch_data", "report"], subflows: [] },
	],
});

const io = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object" as const,
	properties: properties as Record<string, Record<string, unknown>>,
	required,
});

const catalog: PackageCatalog = new Map([
	[
		packageKey("http", "1.0.0"),
		[
			{ name: "get", inputs: io({ url: { type: "string" } }, ["url"]), outputs: io({}) },
			{
				name: "probe",
				inputs: io(
					{ host: { type: "string" }, count: { type: "integer" }, verbose: { type: "boolean" } },
					["host", "count"],
				),
				outputs: io({}),
			},
		],
	],
	[
		packageKey("svc", "2.0.0"),
		[
			{ name: "scan", inputs: io({}), outputs: io({}) },
			{
				name: "track",
				inputs: io(
					{ state: { type: "object", "x-sfly-type": "run_state" }, n: { type: "integer" } },
					["state"],
				),
				outputs: io({}),
			},
		],
	],
	[packageKey("svc", "9.9.9"), null],
]);

const context = {
	catalog,
	defaultVersion: (name: string) => ({ svc: "2.0.0", local: "dev" })[name],
};

const apply = (ops: EditOperationInput[], from = doc()) =>
	applyEditOperations(
		from,
		ops.map((op) => EditOperation.parse(op)),
		context,
	);

const okDoc = (ops: EditOperationInput[], from = doc()) => {
	const result = apply(ops, from);
	if (!result.ok) throw new Error(result.problem.message);
	return result.doc;
};

const problemOf = (ops: EditOperationInput[]) => {
	const result = apply(ops);
	if (result.ok) throw new Error("应该被拒绝");
	return result.problem;
};

const nodeOf = (d: StoredOrchestrationDocument, id: string) =>
	d.nodes.find((n) => n.id === id) as Record<string, unknown> | undefined;

describe("场景的局部编辑：操作", () => {
	describe("add_node", () => {
		it("接在节点后面：和画布上「在后面添加」得到同样的文档（同一组函数）", () => {
			const result = okDoc([
				{ op: "add_node", package: "http", node: "get", after: "fetch_data", inputs: { url: "x" } },
			]);
			const id = uniqueNodeId(
				"get",
				doc().nodes.map((n) => n.id),
			);
			const canvas = insertAfter(doc(), "fetch_data", {
				...newPackageNode("http", "get", id),
				inputs: { url: "x" },
			});
			if (!canvas.ok) throw new Error(canvas.reason);
			expect(result).toEqual(canvas.doc);
			expect(id).toBe("get_1");
			expect(result.edges).toContainEqual({ from: "fetch_data", to: "get_1", kind: "chain" });
			expect(result.edges).toContainEqual({ from: "get_1", to: "report", kind: "chain" });
		});

		it("不写 after：只加节点，不连线、不给坐标（保存时按整理布局补）；写了 id 就用它", () => {
			const result = okDoc([
				{ op: "add_node", id: "scan_log", package: "svc", node: "scan", display_name: "扫日志" },
			]);
			expect(nodeOf(result, "scan_log")).toEqual({
				id: "scan_log",
				kind: "package",
				package: "svc",
				node: "scan",
				always: false,
				inputs: {},
				display_name: "扫日志",
			});
			expect(result.edges).toEqual(doc().edges);
			// 还没锁定的包：用默认版本锁定（控制面给的最新发布版本，或者 dev）
			expect(result.packages).toEqual({ http: "1.0.0", svc: "2.0.0" });
		});

		it("显示名称、备注、Agent、执行设置一起写", () => {
			const result = okDoc([
				{
					op: "add_node",
					id: "p",
					package: "http",
					node: "probe",
					inputs: { host: "h", count: 3 },
					display_name: "探测",
					note: "压测前确认可达",
					agent: "agent-b",
					always: true,
					timeout: 30,
					retries: 2,
					queue_timeout: 60,
				},
			]);
			expect(nodeOf(result, "p")).toMatchObject({
				display_name: "探测",
				note: "压测前确认可达",
				agent: "agent-b",
				always: true,
				timeout: 30,
				retries: 2,
				queue_timeout: 60,
			});
		});

		it("缺必填输入：列出缺哪几个和各自的类型", () => {
			const problem = problemOf([
				{ op: "add_node", package: "http", node: "probe", inputs: { verbose: true } },
			]);
			expect(problem).toMatchObject({
				index: 0,
				op: "add_node",
				missing: [
					{ name: "host", type: "string" },
					{ name: "count", type: "integer" },
				],
			});
			expect(problem.message).toBe(
				"第 1 个操作（add_node）：节点类型 http/probe 缺少必填输入：host（string）、count（integer）",
			);
		});

		it("节点类型、输入名、包版本不对时列出可选的；已经锁定的包只能用锁定的版本", () => {
			expect(problemOf([{ op: "add_node", package: "http", node: "prob" }])).toMatchObject({
				message: "第 1 个操作（add_node）：节点包 http@1.0.0 里没有节点类型 prob，有：get、probe",
				choices: ["get", "probe"],
			});
			expect(
				problemOf([
					{ op: "add_node", package: "http", node: "get", inputs: { url: "x", ur: "y" } },
				]),
			).toMatchObject({
				message: "第 1 个操作（add_node）：节点类型 http/get 没有输入 ur，有：url",
				choices: ["url"],
			});
			expect(
				problemOf([{ op: "add_node", package: "svc", node: "scan", version: "9.9.9" }]).message,
			).toBe("第 1 个操作（add_node）：控制面上没有节点包版本 svc@9.9.9");
			expect(
				problemOf([{ op: "add_node", package: "http", node: "get", version: "2.0.0" }]).message,
			).toBe(
				"第 1 个操作（add_node）：场景锁定的是 http@1.0.0，同一个包在一个场景里只能用一个版本；换版本用 pull / push 改 packages",
			);
			expect(problemOf([{ op: "add_node", package: "nope", node: "x" }]).message).toBe(
				"第 1 个操作（add_node）：控制面上没有节点包 nope：没有发布过，也没有在线的 Agent 加载着它的开发版本",
			);
		});

		it("「运行状态」类型的输入不用写：和画布上一样直接填好 ${{ run.state }}，必填也不算缺", () => {
			const result = okDoc([
				{ op: "add_node", id: "t", package: "svc", node: "track", inputs: { n: 1 } },
			]);
			expect(nodeOf(result, "t")).toMatchObject({ inputs: { state: "${{ run.state }}", n: 1 } });
			expect(newPackageNode("svc", "track", "t", ["state"]).inputs).toEqual({
				state: "${{ run.state }}",
			});
		});

		it("开发版本的节点类型不知道时（没有在线的 Agent 上报）不检查节点类型和输入", () => {
			const result = okDoc([{ op: "add_node", id: "l", package: "local", node: "whatever" }]);
			expect(result.packages.local).toBe("dev");
		});

		it("节点 ID 已经有了、after 的节点不存在：拒绝", () => {
			expect(
				problemOf([
					{ op: "add_node", id: "report", package: "http", node: "get", inputs: { url: "x" } },
				]).message,
			).toBe("第 1 个操作（add_node）：节点 ID report 已存在");
			expect(
				problemOf([
					{ op: "add_node", package: "http", node: "get", after: "fetch", inputs: { url: "x" } },
				]),
			).toMatchObject({
				message: "第 1 个操作（add_node）：节点 fetch 不存在，相近的节点：fetch_data",
				similar: ["fetch_data"],
			});
		});
	});

	describe("remove_node", () => {
		it("和画布上删除一样：前后接上，注释框里的成员一起去掉", () => {
			const result = okDoc([{ op: "remove_node", node: "fetch_data" }]);
			const canvas = removeNodes(doc(), ["fetch_data"]);
			if (!canvas.ok) throw new Error(canvas.reason);
			expect(result).toEqual(canvas.doc);
			expect(result.edges).toContainEqual({ from: "entry", to: "report", kind: "chain" });
			expect(result.annotations?.[0]?.nodes).toEqual(["report"]);
		});

		it("入口节点不能删；节点不存在时列出相近的 ID", () => {
			expect(problemOf([{ op: "remove_node", node: "entry" }]).message).toBe(
				"第 1 个操作（remove_node）：入口节点不能删除",
			);
			expect(problemOf([{ op: "remove_node", node: "Report" }])).toMatchObject({
				similar: ["report"],
			});
		});

		it("没有相近的 ID 时列出场景里全部的节点", () => {
			expect(problemOf([{ op: "remove_node", node: "zzzzzz" }])).toMatchObject({
				message:
					"第 1 个操作（remove_node）：节点 zzzzzz 不存在，场景里的节点：entry、fetch_data、report、spawn、sub",
				similar: [],
				choices: ["entry", "fetch_data", "report", "spawn", "sub"],
			});
		});
	});

	describe("connect / disconnect", () => {
		it("断开再连上：和画布上一样（disconnectEdge，checkConnection 通过后追加连线）", () => {
			const result = okDoc([
				{ op: "disconnect", from: "fetch_data", to: "report" },
				{ op: "connect", from: "spawn", to: "report" },
			]);
			const cut = disconnectEdge(doc(), { from: "fetch_data", to: "report", kind: "chain" });
			const edge = { from: "spawn", to: "report", kind: "chain" } as const;
			expect(checkConnection(cut, edge)).toBeNull();
			expect(result).toEqual({ ...cut, edges: [...cut.edges, edge] });
		});

		it("两端接不上时写明两端各是什么", () => {
			expect(problemOf([{ op: "connect", from: "report", to: "sub" }])).toMatchObject({
				message:
					"第 1 个操作（connect）：子流程入口节点只能由调度连线触发（起点 report 是包节点 http/get，终点 监控（sub）是子流程入口）",
				from: { id: "report", kind: "package", type: "http/get" },
				to: { id: "sub", kind: "subflow_entry" },
			});
			expect(
				problemOf([{ op: "connect", from: "report", to: "sub", kind: "dispatch" }]).message,
			).toBe(
				"第 1 个操作（connect）：调度连线只能从异步任务节点连出（起点 report 是包节点 http/get，终点 监控（sub）是子流程入口）",
			);
			expect(problemOf([{ op: "connect", from: "fetch_data", to: "spawn" }]).message).toBe(
				"第 1 个操作（connect）：节点 取数据（fetch_data） 已有出线，链不能分叉（起点 取数据（fetch_data）是包节点 http/get，终点 spawn 是异步任务）",
			);
		});

		it("连线的端点不存在时列出相近的 ID；断开不存在的连线时写明这个节点现有的连线", () => {
			expect(problemOf([{ op: "connect", from: "fetch-data", to: "report" }])).toMatchObject({
				similar: ["fetch_data"],
			});
			expect(problemOf([{ op: "disconnect", from: "entry", to: "report" }]).message).toBe(
				"第 1 个操作（disconnect）：没有连线 entry → report（chain）；entry 的连线：entry → fetch_data（chain）",
			);
		});
	});

	describe("set", () => {
		it("改输入、显示名称、备注、Agent、执行设置；不写 value 就是去掉", () => {
			const result = okDoc([
				{ op: "set", node: "report", field: "inputs.url", value: "${{ params.host }}" },
				{ op: "set", node: "report", field: "display_name", value: "出报告" },
				{ op: "set", node: "report", field: "note", value: "依赖报表服务" },
				{ op: "set", node: "report", field: "agent", value: "agent-b" },
				{ op: "set", node: "report", field: "timeout", value: 60 },
				{ op: "set", node: "report", field: "always", value: true },
				{ op: "set", node: "fetch_data", field: "display_name" },
			]);
			expect(nodeOf(result, "report")).toMatchObject({
				inputs: { url: "${{ params.host }}" },
				display_name: "出报告",
				note: "依赖报表服务",
				agent: "agent-b",
				timeout: 60,
				always: true,
			});
			expect(nodeOf(result, "fetch_data")).not.toHaveProperty("display_name");
			expect(
				nodeOf(okDoc([{ op: "set", node: "report", field: "always" }]), "report")?.always,
			).toBe(false);
		});

		it("节点上已经有、节点类型没有声明的输入：照常能改、能去掉（保存时也不检查它）", () => {
			const legacy = doc();
			(legacy.nodes[2] as { inputs: Record<string, unknown> }).inputs.extra = "old";
			const changed = okDoc(
				[{ op: "set", node: "report", field: "inputs.extra", value: "new" }],
				legacy,
			);
			expect(nodeOf(changed, "report")?.inputs).toEqual({ url: "http://b.test", extra: "new" });
			const removed = okDoc([{ op: "set", node: "report", field: "inputs.extra" }], legacy);
			expect(nodeOf(removed, "report")?.inputs).toEqual({ url: "http://b.test" });
		});

		it("字段名不对、值不合法、改了不能改的字段：拒绝并写明能改什么", () => {
			expect(
				problemOf([{ op: "set", node: "report", field: "timeout", value: "60s" }]).message,
			).toMatch(/^第 1 个操作（set）：字段 timeout 的值不合法：/);
			expect(
				problemOf([{ op: "set", node: "report", field: "package", value: "x" }]),
			).toMatchObject({
				message:
					"第 1 个操作（set）：包节点 report 不能改字段 package，能改：inputs.<输入名>、agent、display_name、note、always、timeout、retries、queue_timeout",
			});
			expect(
				problemOf([{ op: "set", node: "sub", field: "display_name", value: "x" }]).message,
			).toBe("第 1 个操作（set）：子流程入口节点 监控（sub）不能改字段 display_name，能改：note");
			expect(
				problemOf([{ op: "set", node: "report", field: "inputs.ur", value: "x" }]),
			).toMatchObject({
				message: "第 1 个操作（set）：节点类型 http/get 没有输入 ur，有：url",
			});
		});
	});

	it("一组操作里有一个不合法：整组不生效，传入的文档不变，指出是第几个", () => {
		const before = doc();
		const snapshot = JSON.parse(JSON.stringify(before));
		const result = applyEditOperations(
			before,
			[
				{ op: "remove_node", node: "report" },
				{ op: "connect", from: "fetch_data", to: "nope", kind: "chain" },
			].map((op) => EditOperation.parse(op)),
			context,
		);
		expect(result).toMatchObject({ ok: false, problem: { index: 1, op: "connect" } });
		expect(before).toEqual(snapshot);
	});

	it("后面的操作看得到前面加的节点", () => {
		const result = okDoc([
			{ op: "add_node", id: "a", package: "svc", node: "scan" },
			{ op: "connect", from: "report", to: "a" },
			{ op: "set", node: "a", field: "display_name", value: "扫描" },
		]);
		expect(result.edges).toContainEqual({ from: "report", to: "a", kind: "chain" });
		expect(nodeOf(result, "a")?.display_name).toBe("扫描");
	});
});

describe("审查补的几处", () => {
	it("add_node 写的节点 ID 要能出现在引用里：只能用字母、数字、下划线和连字符", () => {
		for (const id of ["a b", "a.b", "中文"]) {
			expect(problemOf([{ op: "add_node", id, package: "svc", node: "scan" }]).message).toBe(
				`第 1 个操作（add_node）：节点 ID ${JSON.stringify(id)} 不能用：只能用字母、数字、下划线和连字符（输出的引用里要写它：\${{ nodes.<节点 ID>.outputs.<输出> }}）`,
			);
		}
		expect(
			nodeOf(okDoc([{ op: "add_node", id: "scan-2_b", package: "svc", node: "scan" }]), "scan-2_b"),
		).toBeDefined();
	});

	it("set 写 null 就是 null（输入可以是 null），不写 value 才是去掉", () => {
		const result = okDoc([{ op: "set", node: "report", field: "inputs.url", value: null }]);
		expect(nodeOf(result, "report")?.inputs).toEqual({ url: null });
		expect(
			problemOf([{ op: "set", node: "report", field: "timeout", value: null }]).message,
		).toMatch(/^第 1 个操作（set）：字段 timeout 的值不合法：/);
	});
});

describe("相近的节点 ID", () => {
	const ids = ["entry", "fetch_data", "fetch_meta", "report", "check_1", "check_2"];
	it("大小写、分隔符、少一两个字、是其中一段：按相近程度排", () => {
		expect(similarNodeIds("Report", ids)).toEqual(["report"]);
		expect(similarNodeIds("fetch-data", ids)).toEqual(["fetch_data", "fetch_meta"]);
		expect(similarNodeIds("check", ids)).toEqual(["check_1", "check_2"]);
		expect(similarNodeIds("zzzzzz", ids)).toEqual([]);
		// 短 ID 不因为是长 ID 里的一段就算相近：entry 不是 entry_point_check 的近似
		expect(similarNodeIds("entry_point_check", ["entry", "a1", "entry_point_chek"])).toEqual([
			"entry_point_chek",
		]);
	});
});
