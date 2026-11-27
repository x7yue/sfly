import { z } from "zod";
import { AgentNameText } from "./agents.js";
import { endpoint } from "./contract.js";

/** 项目本身的设置的接口契约（约定见 ./contract.ts）：现在只有「登记工作台」（ADR 0027、0029「迁移与过渡」，#549）。 */

/** 登记的结果：登记了哪台 Agent，和它换下来的上一台（第一次登记、或登记的就是同一台时为 null）。 */
export const WorkbenchRegistration = z.object({
	/** 项目标识。 */
	project: z.string(),
	/** 现在登记的工作台：Agent 的名字。 */
	agent: z.string(),
	/** 换下来的上一台工作台；第一次登记为 null，登记的就是同一台时也是 null（没有换）。 */
	previous_agent: z.string().nullable(),
});
export type WorkbenchRegistration = z.infer<typeof WorkbenchRegistration>;

export const projectWorkbenchApi = {
	/**
	 * 登记这个项目的工作台（助手的会话在哪台 Agent 上做事，ADR 0027）。要「管理」范围，只认人的凭据（登录、个人令牌）。
	 * **登记之后控制面只接受 Agent 凭据**：共享令牌和不带凭据的连接都被拒绝，对整个部署生效，不只这个项目
	 * （共享令牌不发给工作台，但工作台在网络上够得着控制面，别处泄露的共享令牌就能冒充一台还没换凭据的 Agent，ADR 0029）。
	 * 这个开关由库里是不是有项目登记了工作台得出，控制面重启后照旧；**没有注销登记的接口**：要换工作台，用另一台 Agent 再登记一次
	 * （工作台本身要满足下面的前三条），响应里的 `previous_agent` 是换下来的；登记同一台是幂等的。
	 *
	 * 登记的条件（任何一条不满足都是 409，不改任何东西，`error.code` 就是下面写的）：
	 * - `workbench_agent_unknown`：这个项目里没有这台 Agent（它要先用自己的 Agent 凭据连上来过一次；别的项目里的名字和不存在一样）；
	 * - `workbench_agent_disabled`：这台 Agent 被停用了；
	 * - `workbench_agent_not_on_credential`：这台 Agent 最近一次连接用的不是 Agent 凭据；
	 * - `agents_not_on_credentials`：部署里还有没有停用的 Agent 最近一次连接用的不是 Agent 凭据（只签发过凭据、没用它连上过的也算没换）；
	 *   `details.agents` 列出它们的名字：为它们签发 Agent 凭据并换上重新连接，或者停用它们（`POST /projects/:project/agents/:name/disable`），再登记。
	 *   **已经有项目登记过工作台（控制面已经只接受 Agent 凭据）时不再检查这一条**：换工作台只看工作台本身的前三条。
	 */
	register: endpoint({
		method: "PUT",
		path: "/projects/:project/workbench",
		summary: "登记这个项目的工作台（一台 Agent）；登记之后控制面只接受 Agent 凭据",
		effect: "write",
		resource: { kind: "project", target: { params: "project" } },
		client: false,
		key: ["projects", "register-workbench"],
		params: z.object({ project: z.string().min(1) }),
		body: z
			.object({
				/** 工作台那台 Agent 的名字。 */
				agent: AgentNameText,
			})
			.strict(),
		response: WorkbenchRegistration,
	}),
};
