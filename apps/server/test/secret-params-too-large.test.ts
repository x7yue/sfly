// secret 参数的值合计超过上限的运行，触发之前就拦下并说明（#632，docs/SEMANTICS.md §2.1「值集合太大时」、§6）：
// 这次触发里所有 secret 值的所有写法合计超过上限（`SecretSet.oversize`）时，运行里日志、动作、运行视图里的文字会全部盖住，而且是永久的，
// 所以触发时按实际的值（触发时给的、运行预设里的、默认值，子流程里是异步任务节点传入的）拒绝（400 `invalid_params`，
// details 里是 `secret_params_too_large`），写明合计约多少（取整到千）、上限多少、占得最多的是哪几个参数、怎么办；
// 触发时改不了的值（子流程的常量、子流程自己的默认值）超限是预检的阻断项；预检接口按场景里的默认值和运行预设给警告（`warnings`，
// 带 `origin`）。说明里只有取整的个数，没有值的任何片段。真实的控制面；值都是假值，上限调小到几万个字符。
import { runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSecretSetCache,
	secretLimits,
	secretSetCacheStats,
	secretSetUncached,
} from "../src/logs/secrets.js";
import { asStoredJson } from "../src/util/jsonb.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk, triggerWithPreset } from "./support/presets.js";
import { withSecretLimits, withSecretLimitsSync } from "./support/secret-limits.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const LIMIT = 30_000;
const CODE = "secret_params_too_large";

/**
 * 恰好 `length` 个字符的假值：用说明里不会出现的字符（不是汉字、数字只有 7、没有常见的英文词），没有要转义的字符，
 * 所以所有写法只有这一份；`tag` 让不同的值不同，同一个 `tag` 总是同一个值。
 */
const ALPHABET = "QWXZJKVq#%&7";
function fake(tag: string, length: number): string {
	let state = 2166136261;
	for (const c of tag) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
	let out = "";
	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out += ALPHABET[(state >>> 16) % ALPHABET.length];
	}
	return out;
}
/** 值的任何 4 个字符的片段出现在 `text` 里的有哪些（空表示一个都没有）。 */
function leakedFragments(text: string, values: string[]): string[] {
	const leaked: string[] = [];
	for (const value of values) {
		const fragments = new Set<string>();
		for (let i = 0; i + 4 <= value.length; i++) fragments.add(value.slice(i, i + 4));
		for (const fragment of fragments) if (text.includes(fragment)) leaked.push(fragment);
	}
	return leaked;
}
const secret = (name: string, extra: Record<string, unknown> = {}) =>
	param(name, { secret: true, ...extra });
/** 取整到千（向上）。 */
const up = (n: number) => Math.ceil(n / 1000) * 1000;

interface Rejection {
	code: string;
	message: string;
	details: { code: string; message: string; node_id?: string }[];
}

/** 说明的三行。 */
const SUM_NOTE =
	"（这个数是所有写法合计的，对象、数组会是它自身大小的好几倍，见文档「secret 参数的大小上限」）";
const lines = (reason: string, total: number, listed: string, advice: string) => [
	`${reason}：所有写法合计约 ${total} 个字符${SUM_NOTE}，超过上限 ${LIMIT} 个字符。超过上限的运行里，日志、动作、运行视图里的文字会全部显示为 ******，而且之后一直是这样，所以不让触发。`,
	listed,
	advice,
];
const HOW =
	"不要把整份大的 JSON 或整个文件放进一个 secret 参数，只把真正要打码的字段单独做成 secret 参数，其余的做成普通参数。";
const ADVICE = `怎么办：缩短这些值；${HOW}`;
const ADVICE_FIXED = `怎么办：改场景：缩短上面这些子流程参数的值（节点传的常量、子流程入口节点上的默认值）；${HOW}`;

describe("值集合的总长判断：不建自动机，不进缓存", () => {
	it("总长不超上限的值集合问 oversize：不建自动机（watchBuild 不会被通知），超过的是 true，和打码时整段盖住是同一个判断", () => {
		clearSecretSetCache();
		const small = secretSetUncached([fake("a", 10_000)]);
		expect(small.oversize).toBe(false);
		let built = false;
		small.watchBuild(() => {
			built = true;
		});
		expect(built).toBe(false);
		expect(small.chars).toBe(10_000);
		expect(secretSetCacheStats()).toEqual({ entries: 0, bytes: 0 });

		withSecretLimitsSync({ automatonChars: LIMIT }, () => {
			const big = secretSetUncached([fake("b", LIMIT + 1)]);
			expect(big.oversize).toBe(true);
			expect(big.mask(`x ${fake("b", LIMIT + 1)} y`)).toBe("******");
			const exact = secretSetUncached([fake("c", LIMIT)]);
			expect(exact.oversize).toBe(false);
			expect(exact.mask(`x ${fake("c", LIMIT)} y`)).toBe("x ****** y");
		});
	});
});
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
	const preflightOf = async (id: string) =>
		runsApi.preflight.response.parse(await api.getJson(`/orchestrations/${id}/preflight`));
	const codes = (list: Array<{ code: string }>) => list.map((p) => p.code);

	it("触发时给的值：合计超过上限就拒绝，说明三行（原因、占得最多的参数大的在前、怎么办），大小取整到千（向上），不产生运行，没有值的任何片段", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("small"), secret("big")]);
			const small = fake("small", 12_001);
			const big = fake("big", 20_001);

			const error = await rejected(await api.trigger(id, { small, big }));
			expect(error.code).toBe("invalid_params");
			const message = lines(
				"这次触发的 secret 参数的值太多或太长",
				up(32_002),
				`占得最多的是 参数 big（约 ${up(20_001)} 个字符）、参数 small（约 ${up(12_001)} 个字符）。`,
				ADVICE,
			).join("\n");
			expect(error.message).toBe(message);
			expect(error.details).toEqual([{ code: CODE, message }]);
			expect(await runsOf(id)).toEqual([]);
			// 说明里没有值的任何 4 个字符的片段
			expect(leakedFragments(JSON.stringify(error), [small, big])).toEqual([]);
		});
	}, 60_000);

	it("合计恰好等于上限放行，多一个字符就拒绝（和运行里「值集合太大」是同一个判断）", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([secret("a"), secret("b")]);

			const exact = await api.trigger(id, { a: fake("a", 20_000), b: fake("b", 10_000) });
			expect(exact.status, await exact.clone().text()).toBe(201);
			const over = await rejected(
				await api.trigger(id, { a: fake("a", 20_000), b: fake("b", 10_001) }),
			);
			expect(codes(over.details)).toEqual([CODE]);
			expect(over.message).toContain(`所有写法合计约 ${up(30_001)} 个字符`);
			expect(over.message).toContain(`超过上限 ${LIMIT} 个字符`);
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
			// 三处都是同一个 20000 个字符的值：值集合里只有一份
			const same = fake("same", 20_000);
			const ok = await api.trigger(id, { a: same, b: same });
			expect(ok.status, await ok.clone().text()).toBe(201);
			// 换一个不同的 b：合计 40000 个字符
			const error = await rejected(await api.trigger(id, { a: same, b: fake("other", 20_000) }));
			expect(error.message).toContain("所有写法合计约 40000 个字符");
		});
	}, 60_000);

	it("不是 secret 的参数再大也不算；没有给值的 secret 参数不算", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const id = await scenario([param("plain"), secret("token"), secret("unused")]);

			const res = await api.trigger(id, {
				plain: fake("plain", 90_000),
				token: fake("token", 500),
			});
			expect(res.status, await res.clone().text()).toBe(201);
		});
	}, 60_000);

	it("占得最多的参数最多列 5 个、小于上限 1% 的不单独列，其余写「另有几个较小的」；都不大、个数多时写个数", async () => {
		await withSecretLimits({ automatonChars: LIMIT }, async () => {
			const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
			const id = await scenario(names.map((name) => secret(name)));
			// p1 到 p6：4001、5001、…、9001 个字符；p7 只有 250 个字符（小于 300，上限的 1%）
			const sizes = [4001, 5001, 6001, 7001, 8001, 9001, 250];
			const params = Object.fromEntries(names.map((name, i) => [name, fake(name, sizes[i] ?? 0)]));
			// 合计 39255
			const error = await rejected(await api.trigger(id, params));
			expect(error.message).toContain(`所有写法合计约 ${up(39_255)} 个字符`);
			expect(error.message.split("\n")[1]).toBe(
				"占得最多的是 参数 p6（约 10000 个字符）、参数 p5（约 9000 个字符）、参数 p4（约 8000 个字符）、参数 p3（约 7000 个字符）、参数 p2（约 6000 个字符），另有 2 个较小的。",
			);

			// 200 个 secret 参数，每个 250 个字符：每个都小于 1%，合计 50000
			const many = Array.from({ length: 200 }, (_, i) => `m${i}`);
			const manyId = await scenario(many.map((name) => secret(name)));
			const manyParams = Object.fromEntries(many.map((name) => [name, fake(name, 250)]));
			const manyError = await rejected(await api.trigger(manyId, manyParams));
			expect(manyError.message.split("\n")[1]).toBe(
				"每个参数都不大，是个数多：共 200 个 secret 参数。",
			);
		});
	}, 60_000);

	describe("JSON 参数：触发时算的和运行里算的是同一份值（对象的键序是库里读回来的样子）", () => {
		const cfgScenario = () => scenario([secret("cfg", { type: "json" })]);
		/** 触发时（请求体的键序）和运行里（库里读回来的键序）这个值的所有写法合计，和中间的一个上限。 */
		const totals = (value: unknown) => {
			const asGiven = secretSetUncached([value]).chars;
			const asStored = secretSetUncached([asStoredJson(value)]).chars;
			return { asGiven, asStored, between: Math.floor((asGiven + asStored) / 2) };
		};

		it("请求体的键序是 aa、b（和排序的一样），库里读回来是 b、aa（先按长度）：运行里的合计比触发时按请求体算的大，所以触发被拒绝；放行的话运行里确实整段盖住", async () => {
			const value = { aa: fake("aa", 10_000), b: "zzzz" };
			const { asGiven, asStored, between } = totals(value);
			expect(asGiven).toBeLessThan(asStored);
			const id = await cfgScenario();

			await withSecretLimits({ automatonChars: between }, async () => {
				const error = await rejected(await api.trigger(id, { cfg: value }));
				expect(codes(error.details)).toEqual([CODE]);
				expect(await runsOf(id)).toEqual([]);
			});
			// 上限放宽之后触发：这个值在运行里的合计就是 asStored，超过 between，运行里确实是整段盖住（触发和运行是同一个判断）
			const runId = await api.triggerOk(id, { cfg: value });
			await withSecretLimits({ automatonChars: between }, async () => {
				expect((await api.run(runId)).secrets_oversize).toBe(true);
			});
		}, 60_000);

		it("反过来：请求体的键序是 b、a（同长，库里读回来是 a、b，和排序的一样），按请求体算会多算两种写法，误拒；按库里的算不超，放行，运行里也确实不超", async () => {
			const value = { b: fake("vb", 10_000), a: fake("va", 10_000) };
			const { asGiven, asStored, between } = totals(value);
			expect(asGiven).toBeGreaterThan(asStored);
			const id = await cfgScenario();

			await withSecretLimits({ automatonChars: between }, async () => {
				const runId = await api.triggerOk(id, { cfg: value });
				expect((await api.run(runId)).secrets_oversize).toBe(false);
			});
		}, 60_000);
	});

	describe("默认值和运行预设", () => {
		it("默认值太大：不给值就拒绝，给了别的（小的）值就放行；预检接口有一条警告（origin 是默认值），不是阻断项，没有值的任何片段", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const bigDefault = fake("default", 40_001);
				const id = await scenario([
					secret("token", { default: bigDefault }),
					param("host", { default: "h" }),
				]);
				// 只固定普通参数的预设，用它触发的 secret 值和只用默认值是同一份：不另给一条警告
				const onlyHost = await createPresetOk(api, id, {
					name: "只有主机",
					params: [{ name: "host", value: "x" }],
				});

				const bare = await rejected(await api.trigger(id, {}));
				expect(codes(bare.details)).toEqual([CODE]);
				expect(bare.message).toContain(`所有写法合计约 ${up(40_001)} 个字符`);
				expect(bare.message).toContain(`参数 token（约 ${up(40_001)} 个字符）`);
				const given = await api.trigger(id, { token: fake("given", 500) });
				expect(given.status, await given.clone().text()).toBe(201);

				const preflight = await preflightOf(id);
				expect(preflight.problems).toEqual([]);
				expect(preflight.warnings).toEqual([
					{
						code: CODE,
						message: lines(
							"场景里 secret 参数的默认值太多或太长，照默认值触发会被拒绝（触发时给这些参数传更小的值就能触发）",
							up(40_001),
							`占得最多的是 参数 token（约 ${up(40_001)} 个字符）。`,
							ADVICE,
						).join("\n"),
						origin: { kind: "defaults", preset_ids: [onlyHost.id] },
					},
				]);
				expect(leakedFragments(JSON.stringify(preflight), [bigDefault])).toEqual([]);
			});
		}, 60_000);

		it("默认值不大、触发时给的值让合计超限：拒绝；预检接口没有警告", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("a", { default: fake("a", 10_000) }),
					secret("b", { default: fake("b", 10_000) }),
				]);

				expect((await preflightOf(id)).warnings.filter((w) => w.code === CODE)).toEqual([]);
				// 只给 b 一个大的新值：a 用默认值（10000）、b 是新值（25000）
				const error = await rejected(await api.trigger(id, { b: fake("new-b", 25_000) }));
				expect(error.message).toContain(`所有写法合计约 ${up(35_000)} 个字符`);
			});
		}, 60_000);

		it("运行预设固定的 secret 值太大：用它触发被拒绝，不用它触发照常；预检接口只给这个预设一条警告（origin 带预设的 ID），小的预设、没有改变 secret 值的预设不给", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("token"),
					param("host", { default: "h" }),
					param("gone", { default: "g" }),
				]);
				const bigValue = fake("preset", 40_001);
				const big = await createPresetOk(api, id, {
					name: "大的",
					params: [{ name: "token", value: bigValue }],
				});
				await createPresetOk(api, id, { name: "小的", params: [{ name: "token", value: "tiny" }] });
				await createPresetOk(api, id, { name: "只有主机", params: [{ name: "host", value: "x" }] });

				const viaPreset = await rejected(await triggerWithPreset(api, id, big.id));
				expect(codes(viaPreset.details)).toEqual([CODE]);
				expect(viaPreset.message).toContain(`所有写法合计约 ${up(40_001)} 个字符`);
				expect(viaPreset.message).toContain(`参数 token（约 ${up(40_001)} 个字符）`);
				const plain = await api.trigger(id, { token: fake("plain", 500) });
				expect(plain.status, await plain.clone().text()).toBe(201);

				const preflight = await preflightOf(id);
				expect(preflight.problems).toEqual([]);
				const warnings = preflight.warnings.filter((w) => w.code === CODE);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.origin).toEqual({ kind: "preset", preset_id: big.id });
				expect(warnings[0]?.message.split("\n")[0]).toContain(
					"运行预设「大的」的 secret 参数的值（其余参数用默认值）太多或太长，用它触发会被拒绝",
				);
				expect(leakedFragments(JSON.stringify(preflight), [bigValue])).toEqual([]);
			});
		}, 60_000);

		it("预设固定的是普通参数，它经参数映射成了子流程的 secret 参数：预设不「没有固定 secret 参数」，值和默认值不同，预检给警告，用它触发被拒绝", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await api.orchestrationWith(
					orchestration(
						[
							[
								{ id: "entry", kind: "entry", params: [param("host", { default: "h" })] },
								spawn("spawn", { token: "${{ params.host }}" }),
							],
							[
								{ id: "sub", kind: "subflow_entry", name: "汇报", params: [secret("token")] },
								echo("s1"),
							],
						],
						[["spawn", "sub"]],
					),
				);
				const preset = await createPresetOk(api, id, {
					name: "大主机",
					params: [{ name: "host", value: fake("host", 40_001) }],
				});
				await createPresetOk(api, id, { name: "小主机", params: [{ name: "host", value: "x" }] });

				const preflight = await preflightOf(id);
				expect(preflight.problems).toEqual([]);
				const warnings = preflight.warnings.filter((w) => w.code === CODE);
				expect(warnings.map((w) => w.origin)).toEqual([{ kind: "preset", preset_id: preset.id }]);
				const error = await rejected(await triggerWithPreset(api, id, preset.id));
				expect(codes(error.details)).toEqual([CODE]);
				expect(error.message).toContain("子流程 汇报（sub） 的参数 token");
			});
		}, 60_000);

		it("预设固定的值加上其余 secret 参数的默认值合计超限，各自单独都不超：预检给警告，用预设触发被拒绝", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("token"),
					secret("base", { default: fake("base", 20_000) }),
				]);
				const preset = await createPresetOk(api, id, {
					name: "合起来",
					params: [{ name: "token", value: fake("preset", 15_000) }],
				});

				const preflight = await preflightOf(id);
				// 默认值单独（20000）不超；预设单独（15000）不超；合起来 35000 超
				expect(codes(preflight.warnings)).toEqual([CODE]);
				expect(preflight.warnings[0]?.message).toContain("运行预设「合起来」");
				expect(preflight.warnings[0]?.message).toContain(`所有写法合计约 ${up(35_000)} 个字符`);
				const error = await rejected(await triggerWithPreset(api, id, preset.id));
				expect(error.message).toContain(`所有写法合计约 ${up(35_000)} 个字符`);
			});
		}, 60_000);

		it("失效的运行预设（它固定的参数在最新版本里改了类型）不能用来触发，预检不为它给警告", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([secret("token"), secret("other")]);
				await createPresetOk(api, id, {
					name: "大的",
					params: [{ name: "token", value: fake("preset", 40_001) }],
				});
				expect(codes((await preflightOf(id)).warnings)).toEqual([CODE]);

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
				const after = await preflightOf(id);
				expect(after.presets.map((p) => p.status)).toEqual(["invalid"]);
				expect(after.warnings).toEqual([]);
			});
		}, 60_000);

		it("预检不建打码用的自动机，也不往运行共用的值集合缓存里放东西（默认值和预设都超限、都不超限，都一样）", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await scenario([
					secret("token", { default: fake("default", 40_001) }),
					secret("other", { default: fake("other", 5_000) }),
				]);
				for (let i = 0; i < 5; i++) {
					await createPresetOk(api, id, {
						name: `预设${i}`,
						params: [{ name: "other", value: fake(`p${i}`, 1_000 * (i + 1)) }],
					});
				}
				await preflightOf(id); // 先让预检用到的别的缓存（例如读预设的视图）就位
				clearSecretSetCache();

				const preflight = await preflightOf(id);
				expect(preflight.warnings.filter((w) => w.code === CODE).length).toBeGreaterThan(0);
				expect(secretSetCacheStats()).toEqual({ entries: 0, bytes: 0 });
			});
		}, 60_000);
	});

	describe("触发时改不了的值：子流程里的常量、子流程入口节点自己的默认值", () => {
		const fixedScenario = (sub: Record<string, unknown>, mapping: Record<string, unknown>) =>
			api.orchestrationWith(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [secret("main")] }, spawn("spawn", mapping)],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "汇报",
								params: [secret("report", sub)],
							},
							echo("s1"),
						],
					],
					[["spawn", "sub"]],
				),
			);

		it("子流程的参数由节点传一个大常量：预检接口是阻断项（带子流程入口节点的 ID，没有警告），说明指出要改场景；触发被拒绝", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const constant = fake("constant", 40_001);
				const id = await fixedScenario({}, { report: constant });

				const preflight = await preflightOf(id);
				expect(preflight.warnings.filter((w) => w.code === CODE)).toEqual([]);
				expect(preflight.problems).toEqual([
					{
						code: CODE,
						node_id: "sub",
						message: lines(
							"场景里写死的 secret 值（子流程的参数由节点传常量，或用子流程入口节点自己的默认值）太多或太长，触发时给什么都改不了",
							up(40_001),
							`占得最多的是 子流程 汇报（sub） 的参数 report（约 ${up(40_001)} 个字符）。`,
							ADVICE_FIXED,
						).join("\n"),
					},
				]);
				// 触发时给什么都被拒（主链的 secret 参数换成小的也一样）
				for (const main of [undefined, "tiny"]) {
					const error = await rejected(await api.trigger(id, main ? { main } : {}));
					expect(codes(error.details)).toEqual([CODE]);
					expect(error.message).toContain("改场景");
				}
				expect(await runsOf(id)).toEqual([]);
				expect(leakedFragments(JSON.stringify(preflight), [constant])).toEqual([]);
			});
		}, 60_000);

		it("改不了的值的检查也不建自动机、不往值集合的缓存里放东西（预检接口和触发时都是）", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await fixedScenario({}, { report: fake("constant", 40_001) });
				await preflightOf(id); // 先让别的缓存（读场景、预设的视图）就位
				clearSecretSetCache();

				const preflight = await preflightOf(id);
				expect(codes(preflight.problems)).toEqual([CODE]);
				expect(secretSetCacheStats()).toEqual({ entries: 0, bytes: 0 });
			});
		}, 60_000);

		it("子流程入口节点自己的默认值太大（节点没有传这个参数）：同样是阻断项", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await fixedScenario({ default: fake("sub-default", 40_001) }, {});
				const preflight = await preflightOf(id);
				expect(codes(preflight.problems)).toEqual([CODE]);
				expect(preflight.problems[0]?.node_id).toBe("sub");
				const error = await rejected(await api.trigger(id, { main: "x" }));
				expect(error.message).toContain("改场景");
			});
		}, 60_000);

		it("子流程的值取自主链的参数（触发时给得了别的值）、取自前面节点的输出：不算改不了的值；主链默认值太大是警告，不是阻断项", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await api.orchestrationWith(
					orchestration(
						[
							[
								{
									id: "entry",
									kind: "entry",
									params: [param("cfg", { default: fake("cfg", 40_001) })],
								},
								echo("e1"),
								spawn("spawn", { report: "${{ params.cfg }}", other: "${{ nodes.e1.outputs.v }}" }),
							],
							[
								{
									id: "sub",
									kind: "subflow_entry",
									name: "汇报",
									params: [secret("report"), secret("other")],
								},
								echo("s1"),
							],
						],
						[["spawn", "sub"]],
					),
				);
				const preflight = await preflightOf(id);
				expect(preflight.problems).toEqual([]);
				expect(preflight.warnings.map((w) => w.origin)).toEqual([
					{ kind: "defaults", preset_ids: [] },
				]);
				const ok = await api.trigger(id, { cfg: "short" });
				expect(ok.status, await ok.clone().text()).toBe(201);
			});
		}, 60_000);
	});

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

		it("异步任务节点传给子流程、取自入口参数的 secret 值也算，说明里写明是哪个子流程的哪个参数", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const mapped = await withSubflow({ report: "${{ params.main }}" });
				const ok = await api.trigger(mapped, { main: fake("main", 20_000) });
				expect(ok.status, await ok.clone().text()).toBe(201);
				const over = await rejected(await api.trigger(mapped, { main: fake("main", 30_001) }));
				expect(over.message).toContain(`所有写法合计约 ${up(30_001)} 个字符`);
				expect(over.message).toContain(
					`参数 main（约 ${up(30_001)} 个字符）、子流程 汇报（sub） 的参数 report（约 ${up(30_001)} 个字符）`,
				);
			});
		}, 60_000);

		it("子流程里 secret 参数的值取自前面节点的输出：触发时算不到，放行（运行里才成为 secret 的值，照 #529 整段盖住）", async () => {
			await withSecretLimits({ automatonChars: LIMIT }, async () => {
				const id = await withSubflow({ report: "${{ nodes.e1.outputs.v }}" });
				const res = await api.trigger(id, { main: fake("main", 500) });
				expect(res.status, await res.clone().text()).toBe(201);
			});
		}, 60_000);
	});

	it("真实的上限：所有写法合计超过 2^20 个字符的 json secret 参数，触发被拒绝，说明里是真实的上限", async () => {
		expect(secretLimits.automatonChars).toBe(1 << 20);
		const id = await scenario([secret("cfg", { type: "json" })]);
		// 3000 个键，每个值 150 个字符：叶子约 0.5 M 个字符，整个对象的几种写法再各约 0.5 M
		const cfg = Object.fromEntries(
			Array.from({ length: 3000 }, (_, i) => [`k${i}`, fake(`leaf${i}`, 150)]),
		);

		const error = await rejected(await api.trigger(id, { cfg }));
		expect(error.code).toBe("invalid_params");
		expect(codes(error.details)).toEqual([CODE]);
		expect(error.message).toMatch(/所有写法合计约 \d+000 个字符.*超过上限 1048576 个字符/);
		expect(await runsOf(id)).toEqual([]);

		const fewer = Object.fromEntries(Object.entries(cfg).slice(0, 300));
		const ok = await api.trigger(id, { cfg: fewer });
		expect(ok.status, await ok.clone().text()).toBe(201);
	}, 60_000);
});
