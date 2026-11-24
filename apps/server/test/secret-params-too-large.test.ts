// secret 参数的值合计超过上限的运行，触发之前就拦下并说明（#632，docs/SEMANTICS.md §2.1「值集合太大时」、§6）：
// 这次触发里所有 secret 值的所有写法合计超过上限（`SecretSet.oversize`）时，运行里日志、动作、运行视图里的文字会全部盖住，而且是永久的，
// 所以触发时按实际的值（触发时给的、运行预设里的、默认值，子流程里是异步任务节点传入的）拒绝（400 `invalid_params`，
// details 里是 `secret_params_too_large`），写明合计多少、上限多少、占得最多的是哪几个参数、怎么办；预检接口按场景里的默认值
// 和运行预设给警告（`warnings`）。说明里只有个数，没有值。真实的控制面；值都是假值，上限调小到几百个字符。
import { runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretLimits } from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk, triggerWithPreset } from "./support/presets.js";
import { withSecretLimits } from "./support/secret-limits.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const LIMIT = 300;
const CODE = "secret_params_too_large";

/** 恰好 `length` 个字符的假值（ASCII，没有要转义的字符，所以所有写法只有这一份）；`tag` 让不同的值不同。 */
const fake = (tag: string, length: number) => `fake-${tag}-`.padEnd(length, "x");
const secret = (name: string, extra: Record<string, unknown> = {}) =>
	param(name, { secret: true, ...extra });

interface Rejection {
	code: string;
	message: string;
	details: { code: string; message: string; node_id?: string }[];
}

describe("secret 参数的值合计太大：触发前拦下", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const scenario = (params: unknown[]) =>
		api.orchestrationWith(
			orchestration([[{ id: "entry", kind: "entry", params }, echo("e1")]], []),
		);
	const rejected = async (res: Response): Promise<Rejection> => {
		expect(res.status, await res.clone().text()).toBe(400);
		const { error } = (await res.json()) as { error: Rejection };
		return error;
	};
	const runsOf = async (id: string) =>
		(await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`)).runs;
	const messageOf = (total: number, listed: string) =>
		`这次触发的 secret 参数的值太多或太长：所有写法合计 ${total} 个字符，超过上限 ${LIMIT} 个字符。` +
		"超过上限的运行里，日志、动作、运行视图里的文字会全部显示为 ******，而且之后一直是这样。" +
		`占得最多的是 ${listed}。` +
		"怎么办：缩短这些值；不要把整份大的 JSON 或整个文件放进一个 secret 参数，" +
		"只把真正要保密的字段单独做成 secret 参数，其余的做成普通参数。";

	it("触发时给的值：合计超过上限就拒绝，写明合计、上限、占得最多的参数（大的在前）和怎么办，不产生运行，说明里没有值", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("small"), secret("big")]);
			const small = fake("small", 100);
			const big = fake("big", 250);

			const error = await rejected(await api.trigger(id, { small, big }));
			expect(error.code).toBe("invalid_params");
			const message = messageOf(350, "参数 big（250 个字符）、参数 small（100 个字符）");
			expect(error.message).toBe(message);
			expect(error.details).toEqual([{ code: CODE, message }]);
			expect(await runsOf(id)).toEqual([]);
			expect(JSON.stringify(error)).not.toContain("fake-");
		});
	}, 60_000);

	it("合计恰好等于上限放行，多一个字符就拒绝（和运行里「值集合太大」是同一个判断）", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("a"), secret("b")]);

			const exact = await api.trigger(id, { a: fake("a", 200), b: fake("b", 100) });
			expect(exact.status, await exact.clone().text()).toBe(201);
			const over = await rejected(await api.trigger(id, { a: fake("a", 200), b: fake("b", 101) }));
			expect(over.details.map((d) => d.code)).toEqual([CODE]);
			expect(over.message).toContain("所有写法合计 301 个字符，超过上限 300 个字符");
			expect(await runsOf(id)).toHaveLength(1);
		});
	}, 60_000);

	it("每种写法只算一次：几个参数的值相同、同一个值经参数映射传进子流程，合计不重复计", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await api.orchestrationWith(
				orchestration(
					[
						[
							{ id: "entry", kind: "entry", params: [secret("a"), secret("b")] },
							spawn("spawn", { k: "${{ params.a }}" }),
						],
						[{ id: "sub", kind: "subflow_entry", name: "汇报", params: [secret("k")] }, echo("s1")],
					],
					[["spawn", "sub"]],
				),
			);
			// 三处都是同一个 250 个字符的值：值集合里只有一份
			const same = fake("same", 250);
			const ok = await api.trigger(id, { a: same, b: same });
			expect(ok.status, await ok.clone().text()).toBe(201);
			// 换一个不同的 b：合计 500 个字符
			const error = await rejected(await api.trigger(id, { a: same, b: fake("other", 250) }));
			expect(error.message).toContain("所有写法合计 500 个字符");
		});
	}, 60_000);

	it("不是 secret 的参数再大也不算；没有给值的 secret 参数不算", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([param("plain"), secret("token"), secret("unused")]);

			const res = await api.trigger(id, { plain: fake("plain", 5000), token: fake("token", 50) });
			expect(res.status, await res.clone().text()).toBe(201);
		});
	}, 60_000);

	it("占得最多的参数最多列 5 个，其余写「另有几个」", async () => {
		await withSecretLimits({ automatonChars: 200 }, async () => {
			const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
			const id = await scenario(names.map((name) => secret(name)));
			// p1 最小、p7 最大：10、20、…、70 个字符，合计 280
			const params = Object.fromEntries(names.map((name, i) => [name, fake(name, (i + 1) * 10)]));

			const error = await rejected(await api.trigger(id, params));
			expect(error.message).toContain("所有写法合计 280 个字符，超过上限 200 个字符");
			expect(error.message).toContain(
				"占得最多的是 参数 p7（70 个字符）、参数 p6（60 个字符）、参数 p5（50 个字符）、参数 p4（40 个字符）、参数 p3（30 个字符），另有 2 个。",
			);
		});
	}, 60_000);

	describe("默认值和运行预设", () => {
		it("默认值太大：不给值就拒绝，给了别的（小的）值就放行；预检接口有警告，不阻断", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("token", { default: fake("default", 400) }),
					param("host", { default: "h" }),
				]);
				// 只固定普通参数的预设，用它触发的 secret 值和只用默认值是同一份：不另给一条警告
				await createPresetOk(api, id, { name: "只有主机", params: [{ name: "host", value: "x" }] });

				const bare = await rejected(await api.trigger(id, {}));
				expect(bare.details.map((d) => d.code)).toEqual([CODE]);
				expect(bare.message).toContain("所有写法合计 400 个字符");
				expect(bare.message).toContain("参数 token（400 个字符）");
				const given = await api.trigger(id, { token: fake("given", 50) });
				expect(given.status, await given.clone().text()).toBe(201);

				const preflight = runsApi.preflight.response.parse(
					await api.getJson(`/orchestrations/${id}/preflight`),
				);
				expect(preflight.problems).toEqual([]);
				expect(preflight.warnings).toEqual([
					{
						code: CODE,
						message: expect.stringContaining(
							"场景里 secret 参数的默认值太多或太长，照默认值触发会被拒绝（触发时给这些参数传更小的值就能触发）：所有写法合计 400 个字符，超过上限 300 个字符。",
						),
					},
				]);
				expect(JSON.stringify(preflight)).not.toContain("fake-default");
			});
		}, 60_000);

		it("默认值不大、触发时给的值让合计超限：拒绝；预检接口没有警告", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("a", { default: fake("a", 100) }),
					secret("b", { default: fake("b", 100) }),
				]);

				const preflight = runsApi.preflight.response.parse(
					await api.getJson(`/orchestrations/${id}/preflight`),
				);
				expect(preflight.warnings.filter((w) => w.code === CODE)).toEqual([]);
				// 只给 b 一个大的新值：a 用默认值（100）、b 是新值（250）
				const error = await rejected(await api.trigger(id, { b: fake("new-b", 250) }));
				expect(error.message).toContain("所有写法合计 350 个字符");
			});
		}, 60_000);

		it("运行预设固定的 secret 值太大：用它触发被拒绝，不用它触发照常；预检接口按预设各给一条警告，失效的预设和没固定 secret 参数的预设不给", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("token"),
					param("host", { default: "h" }),
					param("gone", { default: "g" }),
				]);
				const big = await createPresetOk(api, id, {
					name: "大的",
					params: [{ name: "token", value: fake("preset", 400) }],
				});
				await createPresetOk(api, id, { name: "小的", params: [{ name: "token", value: "tiny" }] });
				await createPresetOk(api, id, { name: "只有主机", params: [{ name: "host", value: "x" }] });

				const viaPreset = await rejected(await triggerWithPreset(api, id, big.id));
				expect(viaPreset.details.map((d) => d.code)).toEqual([CODE]);
				expect(viaPreset.message).toContain("所有写法合计 400 个字符");
				expect(viaPreset.message).toContain("参数 token（400 个字符）");
				const plain = await api.trigger(id, { token: fake("plain", 50) });
				expect(plain.status, await plain.clone().text()).toBe(201);

				const preflight = runsApi.preflight.response.parse(
					await api.getJson(`/orchestrations/${id}/preflight`),
				);
				expect(preflight.problems).toEqual([]);
				const warnings = preflight.warnings.filter((w) => w.code === CODE);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.message).toContain(
					"运行预设「大的」的 secret 参数的值（其余参数用默认值）太多或太长，用它触发会被拒绝：所有写法合计 400 个字符",
				);
				expect(JSON.stringify(preflight)).not.toContain("fake-preset");
			});
		}, 60_000);
	});

	it("失效的运行预设（它固定的参数在最新版本里改了类型）不能用来触发，预检不为它给警告", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("token"), secret("other")]);
			await createPresetOk(api, id, {
				name: "大的",
				params: [{ name: "token", value: fake("preset", 400) }],
			});
			const before = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(before.warnings.map((w) => w.code)).toEqual([CODE]);

			// 最新版本里 token 改成了数字（还是 secret 参数）：预设里的字符串不符合它的类型，预设失效
			await api.saveVersion(
				id,
				orchestration(
					[
						[
							{
								id: "entry",
								kind: "entry",
								params: [secret("token", { type: "number" }), secret("other")],
							},
							echo("e1"),
						],
					],
					[],
				),
			);
			const after = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(after.presets.map((p) => p.status)).toEqual(["invalid"]);
			expect(after.warnings).toEqual([]);
		});
	}, 60_000);

	it("运行预设：预设固定的值加上其余 secret 参数的默认值合计超限，各自单独都不超：预检给警告，用预设触发被拒绝", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("token"), secret("base", { default: fake("base", 200) })]);
			const preset = await createPresetOk(api, id, {
				name: "合起来",
				params: [{ name: "token", value: fake("preset", 150) }],
			});

			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			// 默认值单独（200）不超；预设单独（150）不超；合起来 350 超
			expect(preflight.warnings.map((w) => w.code)).toEqual([CODE]);
			expect(preflight.warnings[0]?.message).toContain("运行预设「合起来」");
			expect(preflight.warnings[0]?.message).toContain("所有写法合计 350 个字符");
			const error = await rejected(await triggerWithPreset(api, id, preset.id));
			expect(error.message).toContain("所有写法合计 350 个字符");
		});
	}, 60_000);

	describe("子流程", () => {
		const withSubflow = (mapping: Record<string, unknown>) =>
			api.orchestrationWith(
				orchestration(
					[
						[
							{ id: "entry", kind: "entry", params: [secret("main")] },
							echo("e1"),
							spawn("spawn", mapping),
						],
						[
							{ id: "sub", kind: "subflow_entry", name: "汇报", params: [secret("report")] },
							echo("s1"),
						],
					],
					[["spawn", "sub"]],
				),
			);

		it("异步任务节点传给子流程的 secret 值也算（常量、取自入口参数），说明里写明是哪个子流程的哪个参数", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const constant = await withSubflow({ report: fake("constant", 400) });
				const error = await rejected(await api.trigger(constant, { main: fake("main", 10) }));
				expect(error.message).toContain("所有写法合计 410 个字符");
				expect(error.message).toContain(
					"子流程 汇报（sub） 的参数 report（400 个字符）、参数 main（10 个字符）",
				);

				const mapped = await withSubflow({ report: "${{ params.main }}" });
				const ok = await api.trigger(mapped, { main: fake("main", 250) });
				expect(ok.status, await ok.clone().text()).toBe(201);
				const mappedOver = await rejected(await api.trigger(mapped, { main: fake("main", 301) }));
				expect(mappedOver.message).toContain("所有写法合计 301 个字符");
			});
		}, 60_000);

		it("子流程里 secret 参数的值取自前面节点的输出：触发时算不到，放行（运行里才成为 secret 的值，照 #529 整段盖住）", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await withSubflow({ report: "${{ nodes.e1.outputs.v }}" });
				const res = await api.trigger(id, { main: fake("main", 50) });
				expect(res.status, await res.clone().text()).toBe(201);
			});
		}, 60_000);
	});

	it("真实的上限：所有写法合计超过 2^20 个字符的 json 保密参数，触发被拒绝，说明里是真实的上限", async () => {
		expect(secretLimits.automatonChars).toBe(1 << 20);
		const id = await scenario([secret("cfg", { type: "json" })]);
		// 3000 个键，每个值 150 个字符：叶子约 0.5 M 个字符，整个对象的两种写法（紧凑、Python 默认）再各约 0.5 M
		const cfg = Object.fromEntries(
			Array.from({ length: 3000 }, (_, i) => [`k${i}`, fake(`leaf${i}`, 150)]),
		);

		const error = await rejected(await api.trigger(id, { cfg }));
		expect(error.code).toBe("invalid_params");
		expect(error.details.map((d) => d.code)).toEqual([CODE]);
		expect(error.message).toMatch(/所有写法合计 \d+ 个字符，超过上限 1048576 个字符/);
		expect(await runsOf(id)).toEqual([]);

		const fewer = Object.fromEntries(Object.entries(cfg).slice(0, 300));
		const ok = await api.trigger(id, { cfg: fewer });
		expect(ok.status, await ok.clone().text()).toBe(201);
	}, 60_000);
});
