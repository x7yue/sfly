import { describe, expect, it } from "vitest";
import { MonitorSearch, runMonitorLink } from "./run-link";

describe("运行监控页的地址参数", () => {
	it("view、node、tab、at 都合法时原样读出", () => {
		expect(
			MonitorSearch.parse({
				view: "detail",
				node: "verify",
				tab: "logs",
				at: "2026-01-01T00:00:06.250Z",
			}),
		).toEqual({ view: "detail", node: "verify", tab: "logs", at: "2026-01-01T00:00:06.250Z" });
		expect(MonitorSearch.parse({ view: "overview" })).toEqual({ view: "overview" });
		expect(MonitorSearch.parse({})).toEqual({});
	});

	it("不合法的视图、页签和时刻当作没给：链接过期或手写错了也能打开页面", () => {
		expect(MonitorSearch.parse({ node: "verify", tab: "metrics", at: "昨天下午" })).toEqual({
			node: "verify",
		});
		expect(MonitorSearch.parse({ view: "charts", node: "verify" })).toEqual({ node: "verify" });
		expect(MonitorSearch.parse({ at: "1767225600000" })).toEqual({});
		expect(MonitorSearch.parse({ at: "2026-01-01T08:00:06+08:00" })).toEqual({});
	});

	it("生成的链接指向这次运行；没给的参数不出现在地址里", () => {
		expect(
			runMonitorLink("run-1", {
				view: "detail",
				node: "probe",
				tab: "logs",
				at: "2026-01-01T00:00:06.250Z",
			}),
		).toEqual({
			to: "/runs/$id",
			params: { id: "run-1" },
			search: { view: "detail", node: "probe", tab: "logs", at: "2026-01-01T00:00:06.250Z" },
		});
		expect(runMonitorLink("run-1", { node: "probe" })).toEqual({
			to: "/runs/$id",
			params: { id: "run-1" },
			search: { node: "probe" },
		});
		expect(runMonitorLink("run-1", {})).toEqual({
			to: "/runs/$id",
			params: { id: "run-1" },
			search: {},
		});
	});

	it("生成的参数能被路由读回来", () => {
		const { search } = runMonitorLink("run-1", {
			view: "detail",
			node: "probe",
			tab: "attempts",
			at: "2026-01-01T00:00:06.250Z",
		});
		expect(MonitorSearch.parse(search)).toEqual(search);
	});
});
