// `controlPlane` 夹具的建立和拆除有自己的时限（fixtures.ts 的 `CONTROL_PLANE_FIXTURE_TIMEOUT_MS`，不占用例的时限，#613）。
// 这条把用例的时限调到 1 秒，再用 `test.extend` 包一层 `controlPlane`，建立和拆除各多睡 2 秒：夹具超过用例的时限，
// 用例仍然通过。去掉夹具自己的时限（`{ timeout: … }`）后失败，报「Test timeout of 1000ms exceeded while setting up "controlPlane"」。
// 它靠 Playwright 的一条规则：不写成元组的改写沿用原夹具的 `timeout`（1.64.1 的 fixture pool 里明写着）；哪天这条规则变了，
// 这条用例会变红，不会悄悄变绿。
import { expect, test } from "./fixtures";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const slow = test.extend({
	controlPlane: async ({ controlPlane }, use) => {
		await sleep(2_000);
		await use(controlPlane);
		await sleep(2_000);
	},
});
slow.describe.configure({ timeout: 1_000 });

slow("controlPlane 的建立和拆除不占用例的时限", async ({ controlPlane }) => {
	expect(controlPlane.httpUrl).toMatch(/^http:/);
});
