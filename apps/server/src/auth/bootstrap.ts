// 第一个管理员怎么来（ADR 0029「认证的几处细节」）：控制面启动时没有任何用户，就生成一次性的初始化码
// （打印在日志里，写进数据目录下只有属主可读的文件），用它在 `/setup` 页建第一个平台管理员；
// 自动化部署和测试可以改用环境变量直接给出初始管理员（只在没有任何用户时生效）。
import {
	AccountDisplayName,
	LOGIN_NAME_PATTERN,
	LOGIN_NAME_RULE,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
} from "@sfly/schema";
import type { AccountService } from "./accounts.js";
import type { SetupCode } from "./setup-code.js";

export interface InitialAdmin {
	loginName: string;
	password: string;
	displayName?: string | undefined;
}

/**
 * 环境变量 `SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD`（可选 `SFLY_ADMIN_DISPLAY_NAME`，默认同登录名）：
 * 两个都没设置时没有初始管理员；只设置了一个，或者登录名、密码不合规矩，都报错退出，不让一个写错的配置悄悄变成「走初始化码」。
 * **显示名这里不检查**：它只在要建初始管理员的那一次启动里才用得到（库里还没有任何用户），那时才和建用户、改显示名同一个检查
 * （`AccountDisplayName`，{@link bootstrapFirstAdmin}）；已经有用户的部署，升级前设过的不合格的值不该让控制面起不来。
 */
export function parseInitialAdmin(
	env: Record<string, string | undefined>,
): InitialAdmin | undefined {
	const loginName = env.SFLY_ADMIN_LOGIN || undefined;
	const password = env.SFLY_ADMIN_PASSWORD || undefined;
	if (loginName === undefined && password === undefined) return undefined;
	if (loginName === undefined || password === undefined) {
		throw new Error(
			"SFLY_ADMIN_LOGIN 和 SFLY_ADMIN_PASSWORD 要一起设置（初始管理员的登录名和密码）",
		);
	}
	if (!LOGIN_NAME_PATTERN.test(loginName)) {
		throw new Error(`SFLY_ADMIN_LOGIN 不合规矩：${LOGIN_NAME_RULE}`);
	}
	if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
		throw new Error(
			`SFLY_ADMIN_PASSWORD 不合规矩：密码要 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`,
		);
	}
	return { loginName, password, displayName: env.SFLY_ADMIN_DISPLAY_NAME || undefined };
}

/**
 * 启动时调用一次：已经有用户就什么都不用做（顺手删掉过时的初始化码文件）；没有用户时，给了初始管理员就直接建，
 * 否则生成初始化码并把它告诉运维。`log` 是写给运维看的日志。
 */
export async function bootstrapFirstAdmin(deps: {
	accounts: AccountService;
	setupCode: SetupCode;
	initialAdmin: InitialAdmin | undefined;
	log: (message: string) => void;
}): Promise<void> {
	const { accounts, setupCode, initialAdmin, log } = deps;
	if (!(await accounts.setupRequired())) {
		await setupCode.discard();
		if (initialAdmin) {
			log(
				"sfly: 已经有用户了，忽略 SFLY_ADMIN_LOGIN 和 SFLY_ADMIN_PASSWORD（它们只在没有任何用户时生效）",
			);
		}
		return;
	}
	if (initialAdmin) {
		// 要建初始管理员了，显示名这时才查（和建用户、改显示名同一个检查）：不合格就不启动，不悄悄存一个看不见的名字。
		const displayName = AccountDisplayName.safeParse(
			initialAdmin.displayName ?? initialAdmin.loginName,
		);
		if (!displayName.success) {
			throw new Error(
				`SFLY_ADMIN_DISPLAY_NAME 不合规矩：${displayName.error.issues.map((issue) => issue.message).join("；")}`,
			);
		}
		await setupCode.discard();
		const created = await accounts.createInitialAdmin({
			loginName: initialAdmin.loginName,
			displayName: displayName.data,
			password: initialAdmin.password,
		});
		if (created) log(`sfly: 已按 SFLY_ADMIN_LOGIN 建好第一个平台管理员 ${initialAdmin.loginName}`);
		return;
	}
	const code = await setupCode.issue();
	log(
		[
			"sfly: 还没有任何用户。用下面的初始化码在 /setup 页建第一个平台管理员（一次性；重启后会换新的，直到有了用户）：",
			`  ${code}`,
			`  同一个码也写在 ${setupCode.file}（只有属主能读）`,
		].join("\n"),
	);
}
