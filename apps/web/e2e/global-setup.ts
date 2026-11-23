import { createMigratedTemplate } from "../../server/test/support/test-database.js";

/** 模板库名经这个环境变量交给 worker：globalSetup 在启动 worker 之前运行，worker 继承它设置的环境变量。 */
export const E2E_TEMPLATE_ENV = "SFLY_E2E_TEMPLATE_DB";

/**
 * 整个运行开始前建一个已经迁移到最新的库，之后每个用例的测试库都从它复制（见 fixtures.ts 的 `controlPlane`）：
 * 控制面启动时要跑完几十个迁移文件，机器忙的时候一个用例光这一步就要几秒（#613）；从模板复制，迁移只在这里跑一次。
 * 返回的函数在整个运行结束后删掉模板（被中断的运行会留下它，和被中断时留下的测试库一样）。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
	const template = await createMigratedTemplate("sfly_e2e_template");
	process.env[E2E_TEMPLATE_ENV] = template.name;
	return () => template.drop();
}
