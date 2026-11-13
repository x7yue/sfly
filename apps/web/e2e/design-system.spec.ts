import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage, seedDashboard } from "./support";

const RING = "rgb(44, 196, 240)";

const pulses = (page: Page) =>
	page.evaluate(
		() =>
			document
				.getAnimations()
				.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse").length,
	);

test("状态标记每种状态一个形状，默认静止；强制颜色模式下用系统文字色照样画出来", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const running = page
		.getByRole("region", { name: "正在运行" })
		.locator('[data-status-dot="running"]');
	const failed = page
		.getByRole("region", { name: "最近失败" })
		.locator('[data-status-dot="failed"]');
	await expect(running).toBeVisible();
	await expect(failed.first()).toBeVisible();
	const outline = (dot: typeof running) =>
		dot.locator("svg").evaluate((svg) => svg.innerHTML.replaceAll(/\s+/g, ""));
	expect(await outline(running)).not.toBe(await outline(failed.first()));
	expect(await pulses(page)).toBe(1);

	await page.emulateMedia({ forcedColors: "active" });
	const forced = await failed
		.first()
		.locator("svg")
		.evaluate((svg) => {
			const style = getComputedStyle(svg);
			return { fill: style.fill, color: style.color };
		});
	expect(forced.fill).toBe(forced.color);
	expect(forced.color).not.toBe("rgba(0, 0, 0, 0)");

	const current = page.getByRole("navigation", { name: "主导航" }).locator('[aria-current="page"]');
	await expect(current).toHaveCSS("outline-style", "solid");
});

test("执行中的脉冲只动 scale 与 opacity，后出现的脉冲与已有的同一相位；减少动效时不脉冲", async ({
	page,
}) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	const addPulse = () =>
		page.evaluate(() => {
			const el = document.createElement("i");
			el.className = "pulse-ring inline-block size-2 rounded-full text-signal";
			el.dataset.testPulse = "";
			document.body.append(el);
		});
	await addPulse();
	await page.waitForTimeout(700);
	await addPulse();
	await expect.poll(() => pulses(page)).toBe(2);
	const phases = () =>
		page.evaluate(() =>
			document
				.getAnimations()
				.filter(
					(a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName === "status-pulse",
				)
				.map((a) => Math.round(Number(a.currentTime) % 1600)),
		);
	await expect.poll(async () => new Set(await phases()).size).toBe(1);
	const properties = await page.evaluate(() => {
		const pulse = document
			.getAnimations()
			.find((a) => a instanceof CSSAnimation && a.animationName === "status-pulse");
		const keyframes = (pulse?.effect as KeyframeEffect).getKeyframes();
		return [...new Set(keyframes.flatMap((k) => Object.keys(k)))]
			.filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p))
			.sort();
	});
	expect(properties).toEqual(["opacity", "scale"]);

	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect.poll(() => pulses(page)).toBe(0);
});

test("运行监控：每个执行中的节点只在时间线上的段尾脉冲一处，加顶栏运行状态这一处整体脉冲，所有脉冲同一相位", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	// 节点行里的脉冲头（链汇总行里还有一份静止的，不脉冲）。
	const heads = page
		.getByRole("region", { name: "链路时间线" })
		.locator("[data-node-row] [data-pulse-head]");
	await expect(heads.first()).toBeVisible();
	const count = await heads.count();
	const owners = () =>
		page.evaluate(() =>
			document
				.getAnimations()
				.filter(
					(a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName === "status-pulse",
				)
				.map((a) => {
					const effect = a.effect as KeyframeEffect;
					const target = effect.target instanceof HTMLElement ? effect.target : null;
					return {
						head: !!target && "pulseHead" in target.dataset,
						dot: !!target && "statusDot" in target.dataset,
						inRow: !!target?.closest("[data-node-row]"),
						inTopBar: !!target?.closest("header"),
						phase: Math.round(Number(a.currentTime) % 1600),
					};
				}),
		);
	await expect.poll(async () => (await owners()).length).toBe(count + 1);
	const all = await owners();
	expect(all.filter((o) => o.head && o.inRow)).toHaveLength(count);
	// 其余只有顶栏的运行状态标签：状态点（时间线行标签、链路标签、切换运行按钮）默认静止。
	expect(all.filter((o) => !o.head)).toEqual([
		expect.objectContaining({ dot: true, inTopBar: true }),
	]);
	await expect.poll(async () => new Set((await owners()).map((o) => o.phase)).size).toBe(1);
});

test("暂停动效是全站的：命令面板里切换，控制台与列表页的脉冲停下、骨架屏不再呼吸、加载图标放慢，刷新后仍然暂停", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await runningScenario(controlPlane, connectAgent, clock);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
	const running = page.getByRole("link", { name: /运行中/ }).first();
	await expect(running).toBeVisible();
	await expect.poll(() => pulses(page)).toBeGreaterThan(0);
	const html = page.locator("html");
	await expect(html).not.toHaveAttribute("data-motion", "paused");

	const toggle = async (name: string) => {
		await page.keyboard.press("Control+k");
		await expect(page.getByRole("combobox", { name: "命令" })).toBeFocused();
		await page.keyboard.type("动效");
		await page.getByRole("option", { name }).click();
	};
	await toggle("暂停动效");
	await expect(html).toHaveAttribute("data-motion", "paused");
	await expect.poll(() => pulses(page)).toBe(0);
	const motion = () =>
		page.evaluate(() => {
			const spin = document.createElement("i");
			spin.className = "animate-spin";
			const skeleton = document.createElement("i");
			skeleton.className = "animate-pulse";
			document.body.append(spin, skeleton);
			const result = {
				spin: getComputedStyle(spin).animationDuration,
				skeleton: getComputedStyle(skeleton).animationName,
			};
			spin.remove();
			skeleton.remove();
			return result;
		});
	expect(await motion()).toEqual({ spin: "3s", skeleton: "none" });

	await page.goto("/runs");
	await expect(page.getByRole("heading", { name: "运行记录" })).toBeVisible();
	await expect(html).toHaveAttribute("data-motion", "paused");
	await expect.poll(() => pulses(page)).toBe(0);

	await toggle("恢复动效");
	await expect(html).not.toHaveAttribute("data-motion", "paused");
	await expect.poll(() => pulses(page)).toBeGreaterThan(0);
	expect(await motion()).toEqual({ spin: "1s", skeleton: "pulse" });
});

test("减少动效：浮层只淡入淡出、加载图标放慢而不停、颜色过渡照常", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();

	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog");
	await expect(palette).toBeVisible();
	expect(await palette.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();

	const motion = await page.evaluate(() => {
		const spin = document.createElement("i");
		spin.className = "animate-spin";
		const skeleton = document.createElement("i");
		skeleton.className = "animate-pulse";
		document.body.append(spin, skeleton);
		const result = {
			spin: getComputedStyle(spin).animationDuration,
			skeleton: getComputedStyle(skeleton).animationName,
		};
		spin.remove();
		skeleton.remove();
		return result;
	});
	expect(motion).toEqual({ spin: "3s", skeleton: "none" });

	await page.goto("/orchestrations");
	await expect(page.getByRole("button", { name: "新建场景" }).first()).toHaveCSS(
		"transition-duration",
		"0.15s",
	);
});

test("键盘焦点环一出现就是青色，不随颜色过渡先灰后青", async ({ page }) => {
	await page.goto("/orchestrations");
	const button = page.getByRole("button", { name: "新建场景" }).first();
	await expect(button).toBeVisible();
	const color = await button.evaluate((el) => {
		(el as HTMLElement).focus({ focusVisible: true } as FocusOptions);
		return getComputedStyle(el).outlineColor;
	});
	expect(color).toBe(RING);
	await expect(button).toHaveCSS("outline-style", "solid");
});

test("开关打开是中性高亮；输入框在强制颜色模式下聚焦时有轮廓", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const dryRun = drawer.getByRole("switch", { name: "dry_run" });
	await dryRun.click();
	await expect(dryRun).toBeChecked();
	const selected = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue("--selected").trim(),
	);
	expect(selected).toBe("#d4d4d4");
	await expect(dryRun).toHaveCSS("background-color", "rgb(212, 212, 212)");

	await page.emulateMedia({ forcedColors: "active" });
	const host = drawer.getByLabel("host");
	await expect(host).toHaveCSS("outline-style", "none");
	await host.focus();
	await expect(host).toHaveCSS("outline-style", "solid");
});

test("等宽字的中文回退到黑体、关闭编程连字；字号随浏览器的默认字号放大", async ({ page }) => {
	await page.goto("/docs/sdk-reference");
	const code = page.locator("article code").first();
	await expect(code).toBeVisible();
	const font = await code.evaluate((el) => {
		const style = getComputedStyle(el);
		return {
			family: style.fontFamily,
			ligatures: style.fontVariantLigatures,
			features: style.fontFeatureSettings,
		};
	});
	expect(font.family).toMatch(/JetBrains Mono.*Noto Sans CJK SC.*Microsoft YaHei.*monospace$/);
	expect(font.ligatures === "none" || /"calt" 0/.test(font.features)).toBe(true);

	expect(await page.evaluate(() => getComputedStyle(document.body).lineHeight)).toBe("20px");
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "20px";
	});
	expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("16.25px");
});
