// 关注项的设置（#344 / #348）：场景设置里的有序列表，不属于场景版本；整份替换、校验和错误码、
// 失效项的状态、最后一次修改的说明。HTTP API + 真实 PostgreSQL，手动时钟。
import type { OrchestrationView } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestrationStore } from "../src/orchestrations/orchestration-store.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import {
	benchDocument,
	type FocusItemBody,
	focusKeys,
	orchestrationView,
	publishBench,
	putFocusItems,
	putFocusItemsOk,
} from "./support/focus-items.js";
import { ManualClock } from "./support/manual-clock.js";
import { packageMetadata } from "./support/package-archive.js";
import { type SingleConnection, singleConnection } from "./support/single-connection.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const LOAD_TPS = { node_id: "load", chart: "TPS" };
const LOAD_LATENCY = { node_id: "load", chart: "延迟" };
const PROBE_LEVEL = { node_id: "probe", chart: "level" };
const WIDE = (n: number): FocusItemBody => ({ node_id: "wide", chart: `m${n}` });

describe("关注项的设置", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;

	/** 有 load、probe 两个节点的场景（已保存第 1 版）。 */
	const scene = (nodes?: Parameters<typeof benchDocument>[0]) =>
		api.orchestrationWith(benchDocument(nodes), "撮合浸泡");
	const errorOf = async (res: Response) =>
		((await res.json()) as { error: { code: string; message: string } }).error;

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishBench(cp);
	});
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("整份替换", () => {
		it("按提交的顺序保存，响应和读取都带每项的状态；不产生新版本，也不要求先保存", async () => {
			const id = await scene();
			const fresh = await orchestrationView(api, id);
			expect(fresh.focus_items).toEqual([]);
			expect(fresh.focus_edit).toBeNull();

			const view = await putFocusItemsOk(api, id, [PROBE_LEVEL, LOAD_TPS]);
			expect(view.focus_items).toEqual([
				{ ...PROBE_LEVEL, status: "ok", chart_type: "line" },
				{ ...LOAD_TPS, status: "ok", chart_type: "area" },
			]);
			expect(view.head_version).toBe(1);
			expect(await orchestrationView(api, id)).toEqual(view);

			const replaced = await putFocusItemsOk(api, id, [LOAD_LATENCY]);
			expect(focusKeys(replaced)).toEqual(["load:延迟"]);
			expect((await putFocusItemsOk(api, id, [])).focus_items).toEqual([]);
			expect(await api.headVersion(id)).toBe(1);
		});

		it("新建的场景还没有版本也能读到空的关注项", async () => {
			const id = await api.createOrchestration("空场景");
			expect(await orchestrationView(api, id)).toMatchObject({ focus_items: [], focus_edit: null });
		});

		it("没有声明的指标生成的默认图表可以设为关注项；只在图表里画出的指标名不行", async () => {
			const id = await scene();
			const view = await putFocusItemsOk(api, id, [{ node_id: "load", chart: "orders" }]);
			expect(view.focus_items).toEqual([
				{ node_id: "load", chart: "orders", status: "ok", chart_type: "stat" },
			]);

			const res = await putFocusItems(api, id, [{ node_id: "load", chart: "p99" }]);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("focus_item_unknown_chart");
		});

		it("名字去掉首尾空白，写空字符串就是没起名；同一个图表可以在不同节点上各设一次", async () => {
			const id = await scene([
				["load", "load"],
				["load2", "load"],
			]);
			const view = await putFocusItemsOk(api, id, [
				{ ...LOAD_TPS, title: "  撮合 TPS " },
				{ node_id: "load2", chart: "TPS", title: "" },
			]);
			expect(view.focus_items).toEqual([
				{ ...LOAD_TPS, title: "撮合 TPS", status: "ok", chart_type: "area" },
				{ node_id: "load2", chart: "TPS", status: "ok", chart_type: "area" },
			]);
		});

		it("名字超过 40 个字符、含换行，或者字段缺失时返回 400 invalid_request", async () => {
			const id = await scene();
			for (const item of [
				{ ...LOAD_TPS, title: "长".repeat(41) },
				{ ...LOAD_TPS, title: "两\n行" },
				{ node_id: "load" },
				{ ...LOAD_TPS, extra: 1 },
			]) {
				const res = await api.patch(`/orchestrations/${id}`, { focus_items: [item] });
				expect(res.status, JSON.stringify(item)).toBe(400);
				expect((await errorOf(res)).code).toBe("invalid_request");
			}
			expect((await orchestrationView(api, id)).focus_items).toEqual([]);
		});

		it("需要昵称；场景不存在时返回 404", async () => {
			const id = await scene();
			const anonymous = await cp.fetch(`/orchestrations/${id}`, {
				method: "PATCH",
				credentials: "omit",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ focus_items: [LOAD_TPS] }),
			});
			expect(anonymous.status).toBe(400);
			expect((await errorOf(anonymous)).code).toBe("nickname_required");

			const missing = await putFocusItems(api, "00000000-0000-4000-8000-000000000000", []);
			expect(missing.status).toBe(404);
		});

		it("可以和名称一起修改；只改名称不动关注项和它的最后修改", async () => {
			const id = await scene();
			clock.advance(60_000);
			const both = await api.patch(
				`/orchestrations/${id}`,
				{ name: "撮合浸泡 · 4 小时", focus_items: [LOAD_TPS] },
				"小红",
			);
			expect(both.status).toBe(200);
			const set = await orchestrationView(api, id);
			expect(set).toMatchObject({ name: "撮合浸泡 · 4 小时" });
			expect(focusKeys(set)).toEqual(["load:TPS"]);

			clock.advance(60_000);
			await api.patch(`/orchestrations/${id}`, { name: "再改名", description: "说明" }, "小明");
			const renamed = await orchestrationView(api, id);
			expect(renamed.name).toBe("再改名");
			expect(renamed.focus_items).toEqual(set.focus_items);
			expect(renamed.focus_edit).toEqual(set.focus_edit);
		});

		it("归档、恢复场景时关注项原样保留，归档期间也能修改", async () => {
			const id = await scene();
			await putFocusItemsOk(api, id, [LOAD_TPS]);
			const archived = await api.postEmpty(`/orchestrations/${id}/archive`);
			expect(archived.status).toBe(200);
			expect(focusKeys(await orchestrationView(api, id))).toEqual(["load:TPS"]);

			const edited = await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL]);
			expect(focusKeys(edited)).toEqual(["load:TPS", "probe:level"]);
			expect((await api.postEmpty(`/orchestrations/${id}/unarchive`)).status).toBe(200);
			expect(focusKeys(await orchestrationView(api, id))).toEqual(["load:TPS", "probe:level"]);
		});
	});

	describe("校验", () => {
		it("最多 8 项：8 项可以，超过 8 项返回 400 focus_items_limit，已有的列表不变", async () => {
			const id = await scene([
				["load", "load"],
				["wide", "wide"],
			]);
			const eight = Array.from({ length: 8 }, (_, i) => WIDE(i + 1));
			expect((await putFocusItemsOk(api, id, eight)).focus_items).toHaveLength(8);

			const res = await putFocusItems(api, id, [...eight, LOAD_TPS]);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("focus_items_limit");
			expect((await orchestrationView(api, id)).focus_items).toHaveLength(8);
		});

		it("同一个 (node_id, chart) 出现两次返回 400 focus_item_duplicate", async () => {
			const id = await scene();
			const res = await putFocusItems(api, id, [
				LOAD_TPS,
				PROBE_LEVEL,
				{ ...LOAD_TPS, title: "换个名字也是重复" },
			]);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("focus_item_duplicate");
			expect((await orchestrationView(api, id)).focus_items).toEqual([]);
		});

		it("新加的项引用最新版本里没有的节点或图表，返回 400 focus_item_unknown_chart", async () => {
			const id = await scene();
			const unknown: FocusItemBody[] = [
				{ node_id: "ghost", chart: "TPS" },
				{ node_id: "load", chart: "不存在的图表" },
				{ node_id: "probe", chart: "TPS" },
				{ node_id: "entry", chart: "TPS" },
			];
			for (const item of unknown) {
				const res = await putFocusItems(api, id, [LOAD_TPS, item]);
				expect(res.status, JSON.stringify(item)).toBe(400);
				expect((await errorOf(res)).code).toBe("focus_item_unknown_chart");
			}
			expect((await orchestrationView(api, id)).focus_items).toEqual([]);
		});

		it("开发版本的节点另选了 Agent：图表按它派发到的 Agent 当前加载的源码判断，不按默认 Agent 的", async () => {
			// 两台 Agent 加载的 bench-dev 声明了不同标题的图表；场景的默认 Agent 是 agent-a，节点 load 另选了 agent-b。
			const metadataJson = (chart: string) =>
				JSON.stringify(
					packageMetadata({
						name: "bench-dev",
						version: "dev",
						nodes: [
							{
								name: "load",
								title: "load",
								entry: "bench_dev:load",
								inputs: { type: "object", properties: {} },
								outputs: { type: "object", properties: {} },
								metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }],
								charts: [{ title: chart, type: "line", metrics: ["tps"] }],
							},
						],
					}),
				);
			for (const [name, chart] of [
				["agent-a", "默认 Agent 的图表"],
				["agent-b", "节点另选的 Agent 的图表"],
			] as const) {
				agents.push(
					await FakeAgent.connect(cp.grpcUrl, {
						name,
						devPackages: [{ name: "bench-dev", source: "/src", metadataJson: metadataJson(chart) }],
					}),
				);
			}
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "load", kind: "package", package: "bench-dev", node: "load", agent: "agent-b" },
				],
				edges: [{ from: "entry", to: "load", kind: "chain" }],
				packages: { "bench-dev": "dev" },
			});

			const theirs = await putFocusItems(api, id, [
				{ node_id: "load", chart: "节点另选的 Agent 的图表" },
			]);
			expect(theirs.status, await theirs.clone().text()).toBe(200);
			const defaults = await putFocusItems(api, id, [
				{ node_id: "load", chart: "默认 Agent 的图表" },
			]);
			expect(defaults.status).toBe(400);
			expect((await errorOf(defaults)).code).toBe("focus_item_unknown_chart");
		});

		it("还没有保存过版本的场景没有节点可以引用", async () => {
			const id = await api.createOrchestration("空场景");
			const res = await putFocusItems(api, id, [LOAD_TPS]);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("focus_item_unknown_chart");
			expect((await putFocusItems(api, id, [])).status).toBe(200);
		});

		it("图表按节点锁定的节点包版本判断：新版本改了图表标题，新加的项只能用新标题", async () => {
			const id = await scene([["load", "load"]]);
			await api.saveVersion(id, benchDocument([["load", "load"]], "2.0.0"));
			const old = await putFocusItems(api, id, [LOAD_TPS]);
			expect(old.status).toBe(400);
			expect((await errorOf(old)).code).toBe("focus_item_unknown_chart");
			const renamed = await putFocusItemsOk(api, id, [{ node_id: "load", chart: "吞吐" }]);
			expect(focusKeys(renamed)).toEqual(["load:吞吐"]);
		});
	});

	describe("失效的项", () => {
		it("节点不在最新版本里：保留在列表里，附上包含它的最后一个版本号，也占名额；可以原样保留、排序、改名", async () => {
			const id = await scene();
			await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL]);

			await api.saveVersion(id, benchDocument([["load", "load"]]));
			const v2 = await orchestrationView(api, id);
			expect(v2.focus_items).toEqual([
				{ ...LOAD_TPS, status: "ok", chart_type: "area" },
				{ ...PROBE_LEVEL, status: "node_missing", last_version: 1 },
			]);

			const kept = await putFocusItemsOk(api, id, [
				{ ...PROBE_LEVEL, title: "探针电平" },
				LOAD_TPS,
			]);
			expect(kept.focus_items).toEqual([
				{ ...PROBE_LEVEL, title: "探针电平", status: "node_missing", last_version: 1 },
				{ ...LOAD_TPS, status: "ok", chart_type: "area" },
			]);

			// 节点回来以后恢复可用；再次移除时，包含它的最后一个版本是第 3 版。
			await api.saveVersion(id, benchDocument());
			expect((await orchestrationView(api, id)).focus_items[0]).toMatchObject({ status: "ok" });
			await api.saveVersion(id, benchDocument([["load", "load"]]));
			expect((await orchestrationView(api, id)).focus_items[0]).toMatchObject({
				status: "node_missing",
				last_version: 3,
			});
		});

		it("图表不存在：节点还在，锁定的节点包版本没有这张图表；同样保留，只有新加的项才检查", async () => {
			const id = await scene([["load", "load"]]);
			await putFocusItemsOk(api, id, [LOAD_TPS, LOAD_LATENCY]);

			await api.saveVersion(id, benchDocument([["load", "load"]], "2.0.0"));
			const view = await orchestrationView(api, id);
			expect(view.focus_items).toEqual([
				{ ...LOAD_TPS, status: "chart_missing" },
				{ ...LOAD_LATENCY, status: "ok", chart_type: "line" },
			]);

			const kept = await putFocusItemsOk(api, id, [LOAD_LATENCY, LOAD_TPS]);
			expect(kept.focus_items.map((i) => i.status)).toEqual(["ok", "chart_missing"]);

			// 移除以后又改了别的，再想加回去就是新加的项，要通过检查（移除之后立刻写回去是撤销，见下一条）。
			await putFocusItemsOk(api, id, [LOAD_LATENCY]);
			await putFocusItemsOk(api, id, [{ ...LOAD_LATENCY, title: "延迟" }]);
			const readded = await putFocusItems(api, id, [LOAD_LATENCY, LOAD_TPS]);
			expect(readded.status).toBe(400);
			expect((await errorOf(readded)).code).toBe("focus_item_unknown_chart");
		});

		it("移除一个已经失效的项以后立刻撤销：写回的是移除之前的列表，失效的项不当作新加入的检查", async () => {
			const id = await scene([
				["load", "load"],
				["probe", "probe"],
			]);
			await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL, LOAD_LATENCY]);
			// 第 2 版去掉了 probe，节点包升到 2.0.0：probe:level 节点不在，load:TPS 图表不存在。
			await api.saveVersion(id, benchDocument([["load", "load"]], "2.0.0"));
			const stale = (view: OrchestrationView) => view.focus_items.map((i) => i.status);
			expect(stale(await orchestrationView(api, id))).toEqual([
				"chart_missing",
				"node_missing",
				"ok",
			]);

			const full = [LOAD_TPS, PROBE_LEVEL, LOAD_LATENCY];
			for (const gone of [LOAD_TPS, PROBE_LEVEL]) {
				const removed = await putFocusItemsOk(
					api,
					id,
					full.filter((item) => item !== gone),
				);
				expect(removed.focus_items).toHaveLength(2);

				const view = await putFocusItemsOk(api, id, full);
				expect(stale(view)).toEqual(["chart_missing", "node_missing", "ok"]);
				expect(view.focus_edit?.summary).toBe(`撤销了移除「${gone.chart}」`);
			}
		});

		it("撤销只在移除之后立刻写回去时才成立：中间改过别的，失效的项就是新加入的", async () => {
			const id = await scene([["load", "load"]]);
			await putFocusItemsOk(api, id, [LOAD_TPS, LOAD_LATENCY]);
			await api.saveVersion(id, benchDocument([["load", "load"]], "2.0.0"));
			await putFocusItemsOk(api, id, [LOAD_LATENCY]);
			await putFocusItemsOk(api, id, []);

			const res = await putFocusItems(api, id, [LOAD_TPS, LOAD_LATENCY]);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("focus_item_unknown_chart");
		});

		it("失效的项也占名额：满 8 项后再加返回 focus_items_limit，移除失效的项后可以再加", async () => {
			const id = await scene([
				["wide", "wide"],
				["probe", "probe"],
			]);
			const seven = Array.from({ length: 7 }, (_, i) => WIDE(i + 1));
			await putFocusItemsOk(api, id, [...seven, PROBE_LEVEL]);
			await api.saveVersion(id, benchDocument([["wide", "wide"]]));

			const full = await putFocusItems(api, id, [...seven, PROBE_LEVEL, WIDE(8)]);
			expect(full.status).toBe(400);
			expect((await errorOf(full)).code).toBe("focus_items_limit");

			const freed = await putFocusItemsOk(api, id, [...seven, WIDE(8)]);
			expect(freed.focus_items).toHaveLength(8);
		});

		it("同一次请求里保留失效的项并加一个有效的新项；加一个失效的新项仍然被拒绝", async () => {
			const id = await scene();
			await putFocusItemsOk(api, id, [PROBE_LEVEL]);
			await api.saveVersion(id, benchDocument([["load", "load"]]));

			const mixed = await putFocusItemsOk(api, id, [PROBE_LEVEL, LOAD_TPS]);
			expect(mixed.focus_items.map((i) => i.status)).toEqual(["node_missing", "ok"]);

			const bad = await putFocusItems(api, id, [
				PROBE_LEVEL,
				LOAD_TPS,
				{ node_id: "x", chart: "y" },
			]);
			expect(bad.status).toBe(400);
			expect((await errorOf(bad)).code).toBe("focus_item_unknown_chart");
		});
	});

	describe("最后一次修改", () => {
		it("记下昵称和控制面时间，一句话说明改了什么：添加、移除、移动、改名、撤销；没有变化的写入不算修改", async () => {
			const id = await scene();
			const edit = async (items: FocusItemBody[], nickname: string) => {
				clock.advance(60_000);
				return (await putFocusItemsOk(api, id, items, nickname)).focus_edit;
			};

			expect(await edit([LOAD_TPS], "小红")).toEqual({
				updated_by: "小红",
				updated_at: "2026-01-01T00:01:00.000Z",
				summary: "添加了「TPS」",
			});
			expect(await edit([LOAD_TPS, PROBE_LEVEL], "小明")).toEqual({
				updated_by: "小明",
				updated_at: "2026-01-01T00:02:00.000Z",
				summary: "添加了「level」",
			});
			expect((await edit([PROBE_LEVEL, LOAD_TPS], "小明"))?.summary).toBe("把「level」移到第 1 位");
			expect((await edit([{ ...PROBE_LEVEL, title: "探针电平" }, LOAD_TPS], "小明"))?.summary).toBe(
				"把「level」改名为「探针电平」",
			);
			expect((await edit([{ ...PROBE_LEVEL, title: "电平" }, LOAD_TPS], "小明"))?.summary).toBe(
				"把「探针电平」改名为「电平」",
			);
			expect((await edit([PROBE_LEVEL, LOAD_TPS], "小明"))?.summary).toBe(
				"把「电平」改名为「level」",
			);
			expect((await edit([PROBE_LEVEL], "小明"))?.summary).toBe("移除了「TPS」");

			// 把移除之前的列表写回去就是撤销。
			expect(await edit([PROBE_LEVEL, LOAD_TPS], "小红")).toEqual({
				updated_by: "小红",
				updated_at: "2026-01-01T00:08:00.000Z",
				summary: "撤销了移除「TPS」",
			});

			// 写入同样的列表：没有变化，最后修改不动。
			clock.advance(60_000);
			const same = await putFocusItemsOk(api, id, [PROBE_LEVEL, LOAD_TPS], "小刚");
			expect(same.focus_edit).toEqual({
				updated_by: "小红",
				updated_at: "2026-01-01T00:08:00.000Z",
				summary: "撤销了移除「TPS」",
			});
		});

		it("一次改了几处时用分号连起来，改得太多只写数量", async () => {
			const id = await scene([
				["load", "load"],
				["probe", "probe"],
				["wide", "wide"],
			]);
			const edit = async (items: FocusItemBody[]) =>
				(await putFocusItemsOk(api, id, items)).focus_edit?.summary;

			expect(await edit([LOAD_TPS, LOAD_LATENCY, PROBE_LEVEL])).toBe("添加了 3 项");
			expect(await edit([LOAD_TPS, LOAD_LATENCY, WIDE(1)])).toBe("添加了「m1」；移除了「level」");
			expect(await edit([])).toBe("移除了 3 项");
			expect(await edit([WIDE(1), WIDE(2), WIDE(3)])).toBe("添加了 3 项");
			expect(await edit([WIDE(3), WIDE(1), WIDE(2)])).toBe("把「m3」移到第 1 位");
			expect(await edit([WIDE(2), WIDE(1), WIDE(3)])).toBe("调整了顺序");
		});

		it("撤销移动和改名时写明是哪一种", async () => {
			const id = await scene();
			const edit = async (items: FocusItemBody[]) =>
				(await putFocusItemsOk(api, id, items)).focus_edit?.summary;
			await edit([LOAD_TPS, PROBE_LEVEL]);

			await edit([PROBE_LEVEL, LOAD_TPS]);
			expect(await edit([LOAD_TPS, PROBE_LEVEL])).toBe("撤销了「TPS」的移动");

			await edit([LOAD_TPS, { ...PROBE_LEVEL, title: "电平" }]);
			expect(await edit([LOAD_TPS, PROBE_LEVEL])).toBe("撤销了「level」的改名");
		});

		it("撤销不能再被撤销：把撤销之前的列表写回去按普通修改说明", async () => {
			const id = await scene();
			await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL]);
			await putFocusItemsOk(api, id, [LOAD_TPS]);
			const undone = await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL]);
			expect(undone.focus_edit?.summary).toBe("撤销了移除「level」");
			const again = await putFocusItemsOk(api, id, [LOAD_TPS]);
			expect(again.focus_edit?.summary).toBe("移除了「level」");
		});
	});

	// 连接池只有 10 个连接：事务占着一个连接时不能再去池里另取，否则 10 个并发的写入会互相等死。
	describe("很多请求同时到达", () => {
		const CONCURRENT = 14;

		it("同时修改同一个场景的关注项：全部完成，列表是其中一次写入的结果", async () => {
			const id = await scene();
			const responses = await Promise.all(
				Array.from({ length: CONCURRENT }, (_, i) =>
					putFocusItems(api, id, [i % 2 === 0 ? LOAD_TPS : LOAD_LATENCY]),
				),
			);
			expect(responses.map((res) => res.status)).toEqual(Array(CONCURRENT).fill(200));
			expect(["load:TPS", "load:延迟"]).toContain(focusKeys(await orchestrationView(api, id))[0]);
		});

		it("同时归档很多个有关注项的场景：全部完成", async () => {
			const ids = await Promise.all(
				Array.from({ length: CONCURRENT }, async () => {
					const id = await scene();
					await putFocusItemsOk(api, id, [LOAD_TPS]);
					return id;
				}),
			);
			const responses = await Promise.all(
				ids.map((id) => api.postEmpty(`/orchestrations/${id}/archive`)),
			);
			expect(responses.map((res) => res.status)).toEqual(Array(CONCURRENT).fill(200));
		});
	});

	describe("在事务里读关注项的状态", () => {
		const ACTOR = { nickname: "测试", via: null, userId: null, token: null, sessionId: null };
		let single: SingleConnection;
		beforeEach(() => {
			single = singleConnection(cp.database.url);
		});
		afterEach(async () => {
			await single.end();
		});
		const store = () =>
			new OrchestrationStore({
				db: single.db,
				clock,
				sessions: new SessionStore({ db: single.db, clock }),
			});

		it("一次加两个来自不同节点的关注项：只用事务的连接、一条一条地对照最新版本", async () => {
			const id = await scene();
			const result = await store().update(id, { focus_items: [LOAD_TPS, PROBE_LEVEL] }, ACTOR);
			expect(result.kind).toBe("updated");
			expect(focusKeys(await orchestrationView(api, id))).toEqual(["load:TPS", "probe:level"]);
			expect(single.mostPending()).toBe(1);
		});

		it("归档关注项来自几个节点的场景：只用事务的连接、一条一条地读", async () => {
			const id = await scene();
			await putFocusItemsOk(api, id, [LOAD_TPS, PROBE_LEVEL, LOAD_LATENCY]);
			const result = await store().archive(id);
			expect(result.kind).toBe("archived");
			expect(focusKeys((result as { orchestration: OrchestrationView }).orchestration)).toEqual([
				"load:TPS",
				"probe:level",
				"load:延迟",
			]);
			expect(single.mostPending()).toBe(1);
		});
	});
});
