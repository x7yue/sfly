# 用 API 客户端做自己的页面

平台自带的页面以编排画布为中心。团队想按自己的用法看运行状况、触发场景，可以自己写**自建页面**，例如看板，或者选一套参数就触发场景的页面。平台不托管自建页面，也不在控制台里展示它，由你自己部署，放在哪里都行。

自建页面用 **API 客户端** `@sfly/client` 调用平台的 HTTP API。它是一个很薄的 TypeScript 包：带类型的接口调用、断线自动重连的事件流订阅、下载地址的拼接、统一的错误类型。浏览器和 Node.js 都能用，页面和你自己的脚本可以共用一套代码。它不依赖任何第三方包，也不要求用 React。

当前控制面的地址是 `{{SFLY_URL}}`，版本 `{{SFLY_VERSION}}`。让 AI 编程助手写页面时，把这一页的原文地址 `{{SFLY_URL}}/docs/api-client.md` 给它。

## 安装

从控制面安装，地址已经填好当前的控制面和版本：

```sh
npm install {{SFLY_URL}}/client/{{SFLY_VERSION}}/sfly-client-{{SFLY_VERSION}}.tgz
```

用 pnpm 时：

```sh
pnpm add {{SFLY_URL}}/client/{{SFLY_VERSION}}/sfly-client-{{SFLY_VERSION}}.tgz
```

- 安装包由控制面提供，不经过 npm 仓库，内网不需要 npm 镜像。装到的版本就是控制面的版本。
- 包里是 ESM 和完整的类型声明，每个方法的说明写着对应的 HTTP 接口和会返回的错误码。
- `package.json` 里记下的是这个下载地址。控制面升级之后，回到这一页重新运行安装命令，见下面的「版本与兼容」。
- 运行环境：Node.js 22 或更新的版本，或者支持 `fetch` 并能按流读取响应体的浏览器（订阅事件流要用）。用自带的 `fetch` 就行，不用另装。

## 创建客户端

```ts
import { createClient } from "@sfly/client";

const client = createClient({
	baseUrl: "{{SFLY_URL}}",
	token: () => localStorage.getItem("sfly-token"),
});
```

- `baseUrl` 是控制面地址。API 客户端直接调用控制面根路径上的接口，地址后面不加 `/api`。
- `token` 是 API 令牌，每个请求（含事件流）都带上它：`Authorization: Bearer <令牌>`，身份由令牌决定，控制面把令牌所属的用户记为触发人、作者、取消人。可以给固定的字符串，也可以给一个函数，每次请求时取值（轮换令牌时用），空值或空白算没有。令牌在网络上就是它的原值：给的 `baseUrl` 是不是本机的 `http://` 地址（令牌会以明文发送）时，每个客户端实例提示一次（默认 `console.warn`，也可以用 `onInsecureToken` 接收），请求照常进行；有条件的话用 https 地址。客户端不会把令牌带到别的主机：浏览器和 Node 的 `fetch` 在跨源重定向时自己去掉 `Authorization`。
  - 令牌在控制台里签发：**个人令牌**（账号菜单里的「令牌」页）代表你自己，权限是令牌的范围和你此刻的角色取交集；**项目令牌**（项目的「项目令牌」页，要「管理」范围）属于项目，给自动化和自建页面用，不能带「管理」范围，触发人记的是令牌的名称。令牌的原值只在签发的那一刻显示一次，要保存好；丢了只能吊销重签。
  - 令牌是凭据，别写进页面的源码或提交进仓库：放在环境变量、部署平台的密钥里，或者让用户在页面里自己填。令牌的范围不够时控制面回 403，令牌过期、被吊销时回 401。
  - 命令行里用 `sfly login` 登录，脚本里设环境变量 `SFLY_API_TOKEN`，见 [用命令行操作平台](platform-cli.md)。
- `nickname`（已弃用）是昵称，只给没有令牌时用：控制台里没有登录的人还在用它，强制鉴权（#494）之后所有请求都要令牌，昵称参数一并删除。给了 `token` 就不再发昵称。昵称不做校验。
- 创建客户端时可以不给令牌，只读的页面用不到它。但每个不是 GET 的请求（触发、取消运行，保存场景版本，增删飞书机器人……）都要令牌（过渡期里没有令牌时要昵称），包括 `agents.updateNow` 这类控制面本身不检查昵称的接口。两者都没有（函数返回空值或空白）时，这些调用在发请求之前就失败，错误码 `nickname_required`（名字是旧的，错误码保持不变）。
- `fetch` 可选：换成自己的实现，例如测试替身，或者经过自己的代理。默认用全局的 `fetch`。
- 每个请求都带请求头 `x-sfly-client: sfly-client/<版本>`。

方法按领域分组，领域名和方法名沿用 HTTP 接口的契约，每个方法对应 `sfly api --list` 列出的一个接口。场景在接口里还叫 `orchestrations`，字段名是 `orchestration_id`。

| 领域 | 方法 |
|---|---|
| `orchestrations`（场景） | `list`、`get`、`head`、`versions`、`version`、`saveVersion`、`restoreVersion`、`check`、`versionDiff`、`edit`、`checkEdits`、`create`、`update`、`copy`、`archive`、`unarchive` |
| `presets`（运行预设） | `list`、`create`、`update`、`copy`、`remove` |
| `runs`（运行） | `list`、`listForOrchestration`、`focus`、`summary`、`preflight`、`trigger`、`taskIo`、`get`、`cancel`、`events` |
| `logs`（日志） | `runPage`、`runEvents`、`runDownload`、`page`、`events`、`download` |
| `metrics`（指标） | `summary`、`catalog`、`series`、`platform` |
| `actions`（动作） | `summary`、`page`、`events` |
| `artifacts`（产物） | `list`、`download` |
| `agents`（sfly Agent） | `list`、`updateNow` |
| `packages`（节点包） | `list`、`get`、`version`、`nodeType` |
| `feishuBots`（飞书机器人） | `list`、`create`、`replaceWebhook`、`references`、`remove`、`test` |
| `sessions`（助手会话） | `list`、`create`、`get`、`events`、`message`、`stop`、`end` |
| `dashboard`（控制台统计） | `get` |
| `system` | `health` |

调用的输入是一个对象：`params` 是路径参数，`query` 是查询参数，`body` 是请求体，和契约声明的一致。路径在项目下的接口（`agents`、`packages`、`feishuBots` 的方法，`orchestrations` 的 `list`、`create`，`runs.list`，`dashboard.get`，`sessions` 的 `list`、`create`）在 `params.project` 里写项目，默认项目是 `default`，例如 `client.agents.list({ params: { project: "default" } })`。返回值是契约的响应类型。下面的例子从上到下是一个连贯的脚本：真实页面里，把它们放进按钮的点击事件或定时刷新里。

## 查询场景和运行

```ts
const { orchestrations } = await client.orchestrations.list({
	params: { project: "default" },
	query: { q: "回归" },
});
const scenario = orchestrations.find((s) => s.name === "回归");
if (!scenario) throw new Error("没有找到场景「回归」");
console.log(scenario.last_run?.status ?? "还没有运行过", scenario.agents);

const { runs, counts } = await client.runs.list({
	params: { project: "default" },
	query: { orchestration_id: scenario.id, limit: 20 },
});
console.log(`失败 ${counts.failed} 次`);
for (const item of runs) {
	console.log(item.id, item.status, item.triggered_by, item.started_at);
	console.log(`在控制台里看：{{SFLY_URL}}/runs/${item.id}`);
}
```

- `orchestrations.list` 列出没有归档的场景，按新建时间从新到旧。`q` 按名称、说明或引用的 Agent 搜索，`status` 按最近一次运行的状态筛选，`agent` 只看引用了这个 Agent 的场景。每一项带着最近一次运行和各节点的状态（`last_run`）、引用的 Agent 和它们是否在线（`agents`），看板画场景卡片只要这一次请求。
- `orchestrations.head` 读最新版本（编辑起点），`orchestrations.version` 读某个版本，`orchestrations.saveVersion` 和 `orchestrations.restoreVersion` 的响应也带版本的 `document`：入口节点和子流程入口节点里，声明为 `secret` 的参数的默认值（`default`）读出来一律是占位符 `"******"`（和运行的参数、运行预设里的 secret 值是同一个掩码，不论参数的类型），原值任何接口都读不到；没有默认值的不动，普通参数的默认值照常返回。认占位符看 `secret` 为 `true` 且 `default` 是 `"******"`，TypeScript 里用 `@sfly/schema` 的 `SECRET_MASK` 和 `isSecretDefaultPlaceholder`。把读出来的文档原样 `saveVersion` 存回去时，占位符表示「沿用上一个版本里同名参数的默认值」（按入口节点 ID 和参数名对应，`base_version` 仍要是最新版本，不是时照常返回 409 `version_conflict`）；给新值就换成新值，删掉 `default` 就去掉默认值；沿用不了（新场景的第一个版本、新增或改了名的参数、类型变了、参数从 secret 改成了普通参数）时返回 400 `secret_default_placeholder`，`details` 是 `{ node_id, param, reason }` 的列表，什么都不保存。所以 secret 参数的默认值写不成 `******` 本身。`runs.trigger` 的 `params` 里 secret 参数的值是 `"******"` 时同样被拒绝（400 `invalid_params`，不产生运行）：这是读取时打的码，不是值，不传这个参数就用默认值；运行预设里 secret 参数的值写 `"******"` 也被拒绝（沿用原值写 `keep`）。触发被拒绝时的 `message` 和 `details` 不回显 secret 参数的值（写成 `******`）。保存时响应的 `warnings` 里，每个写了默认值的 secret 参数有一条 `secret_param_default`：版本不能修改，默认值会一直留在这个版本里，建议改用运行预设或触发时再给出。
- `orchestrations.check` 检查一份场景文档，不保存：请求体和 `saveVersion` 一样（`base_version` 可以不给，不给时对照最新版本），返回的错误（400 `invalid_document`、400 `secret_default_placeholder`、409 `version_conflict`）和 `warnings` 与用同样的请求体保存时完全一样，每条警告多一个 `existing`（改动之前、最新版本里就有同一条：按种类和它指向的节点、输入、注释框判断，不看文字），另有 `diff`：保存之后相对最新版本的差异。`saveVersion` 带 `strict: true` 时，这次改动新带进来了警告（`existing` 为 false 的）就不保存，返回 400 `strict_warnings`，`details` 和 `check` 的响应一样；在保存的同一个事务里判断。`orchestrations.versionDiff` 对比两个版本（`params` 是 `{ id, a, b }`，从版本 `a` 到版本 `b`），返回 `{ diff }`。差异列出新增、删除、改动的节点（带 `display_name`，有显示名称时）和连线、改动字段的前后值（`path` 例如 `inputs.url`、`params.env`、`packages.http`）、注释框的变化；没有差异时每个列表都是空的。
- `orchestrations.edit` 对场景做一组局部编辑（`operations`：加节点、删节点、连线、断开、改一个节点的字段，格式见 `EditOperation`），带 `base_version`，全部生效存成一个新版本（201，和 `saveVersion` 相同的响应，另有这组操作造成的 `diff`）或都不生效：有一个操作不合法时 400 `invalid_operation`，`details` 写明第几个、为什么（相近的节点 ID `similar`、缺的必填输入 `missing`、连线两端的节点 `from` / `to`、可选的 `choices`）；`base_version` 不是最新版本时 409 `version_conflict`。`orchestrations.checkEdits` 只检查不保存，返回 `{ warnings, diff }`，错误和 `edit` 相同。操作由控制面用画布的编辑函数执行，和在画布上做同样的事得到同样的文档。
- **把读到的文档原样存回去前，先去掉已移除的节点。** 场景里可能还留着已移除种类的节点（飞书通知、定时、Sleep，ADR 0028）：读到的文档（`StoredOrchestrationDocument`）里它们是 `RemovedNode`，保存请求的文档（`OrchestrationDocument`）不收，直接传回去既编译不过，运行时也会被拒绝（400 `invalid_document`，写明是哪些节点、怎么替换）。要先按替换办法改写、再删掉它们；只是想存回其余的内容时，用显式的类型谓词过滤，不要按种类名的字面量过滤（TS 推不出类型谓词，编译不过）：

  ```ts
  import type { OrchestrationNode, StoredNode } from "@sfly/client";

  const REMOVED_KINDS = new Set(["feishu_notify", "timer", "sleep"]);
  const isCurrent = (n: StoredNode): n is OrchestrationNode => !REMOVED_KINDS.has(n.kind);

  const id = "<场景 id>";
  const head = await client.orchestrations.head({ params: { id } });
  await client.orchestrations.saveVersion({
    params: { id },
    body: {
      base_version: head.number,
      document: { ...head.document, nodes: head.document.nodes.filter(isCurrent) },
    },
  });
  ```

  这样存回去会丢掉被过滤的节点；它们的配置读到的文档里原样带着（想改写成别的做法就照着写）。
- `runs.list` 列出所有场景的运行，按开始时间从新到旧，最多 `limit` 条（默认 200，最多 500）。可以按 `status`、`orchestration_id` 筛选，`q` 按运行编号前缀或触发人搜索（触发人是包含匹配，所以昵称里有这几个字的人的运行也会出来）；要精确找，用 `triggered_by`（触发人的昵称整个相等，区分大小写）和 `id_prefix`（只按运行编号的前缀，不分大小写，只能写十六进制数字和 `-`），再加 `limit: 1` 就是某个人最近的一次运行。这些筛选一起用，`counts` 也只算筛选之后的运行。`counts` 是各状态的运行数。
- `runs.get` 读一次运行的完整视图：各条链、各个节点的状态，每次尝试的错误和输入、输出。**单个超过 16 KiB 的输入、输出只给大小**：`inputs`、`outputs`（节点层的 `outputs` 也一样）是 `null`，`inputs_omitted_bytes`、`outputs_omitted_bytes` 是存着的大小（打码之前的字节数，向上取整到 KiB；只在内容被省略时不是 `null`，判断是不是被省略了只看它）；整份视图里内联的输入输出合计超过 1 MiB 之后的也一样，所以响应的大小和任务数无关。全文用 `runs.taskIo({ params: { id: taskId } })`（`GET /tasks/:id/io`）取：每一次尝试的输入和输出，打码之后的，`taskId` 是每次尝试的 `task_id`，节点层被省略的输出取它最后一次尝试的。
- 控制台统计用 `dashboard.get`（`setup` 是「开始使用」四步各自是否完成：有在线的 Agent、发布过节点包、有没归档的场景、有过运行；`recent_ended` 是最近 24 小时结束的运行，失败的带 `focus`：场景现在的关注项在这次运行结束时的值，最多 4 项，字段和 `GET /runs/:id/focus?points=0` 的 `items` 相同），Agent 的在线状态和版本用 `agents.list`（`preparing_since` 不为空表示 Agent 在线但还在准备环境、不接任务），一次运行的指标摘要、图表声明和序列用 `metrics.summary`、`metrics.catalog`、`metrics.series`。
- `runs.summary` 读一次运行的摘要（和命令行运行结束时输出的是同一份内容）：运行状态（`status`、取消请求 `cancel`、到此刻为止的结果 `result_so_far`、按失败先后排的 `failures`、每个链实例和它那条链上每个节点的状态、尝试次数、起止时间和失败原因 `chains`），加上 `duration_ms`、失败的任务 `failed_tasks`（每项带完整的错误信息和最后 50 行日志，最多 20 个，总数在 `failed_tasks_total`）、失败的动作 `failed_actions`（最近 10 个）和有异常的关注项 `attention_items`。错误信息和日志里 secret 参数的值已打码；secret 参数的值太多或太长（所有写法合计超过上限）的运行，要打码的内容整段盖住，`secrets_oversize` 为 true（`runs.get` 返回的运行视图里也有），读到的错误信息、日志尾部看到的是 `******`，缩短或减少 secret 参数的值之后重新运行（旧版本的控制面没有这个字段，读不到时当作 false）。判断一次运行「成功且结果对」先读它，不用自己拼运行视图、日志和动作。
- `runs.focus` 一次读出一次运行的全部关注项（`points` 是每个序列降采样的点数，默认 60，最多 300，0 只要最新值）：场景挑出来的关注项，每项带来源节点的状态、最新值、降采样后的序列、估算的采样间隔（`sample_interval_ms`）和异常（`anomaly`：`log` 最近 10 分钟内有 WARN / ERROR，`stale` 执行中却很久没有新数据，`failed` 来源节点失败，`retry` 10 分钟内开始了重试；规则见[运行场景](run-scenario.md)的「关注项」），有异常的排在前面，其余按作者的顺序；场景没设关注项时是准备中、执行中节点的主指标（`mode` 是 `primary`）。运行绑定的版本里没有的节点不返回；节点还没开始（包括所在的子流程还没触发）的项照样返回，`source.started_at` 为 null，没有数据；这次运行锁定的节点包版本里没有这张图表的项，`unavailable` 是 `chart_missing`。自建的看板用它就不用自己拼指标查询。
- 自建的槽位看板读这两处：`agents.list` 里每台 Agent 的 `running_tasks` 是占着槽位的任务，`status` 为 `dispatched`（界面写「准备中」，`started_at` 和 `current_action` 为 `null`）或 `running`，每项带它属于哪个场景（`orchestration_id`、`orchestration_name`）、哪个运行（`run_id`）、哪条链（`chain_instance_id`，`chain_name` 是子流程名称，主链为 `null`）上的哪个节点（`node_id`、`display_name`、`node_type`）的第几次尝试（`attempt`），还有 `started_at`、`current_action` 和 `progress`（见下面「读节点正在做的事」）；`queued_tasks` 是在等这台 Agent 的任务，带同样的定位字段和 `queued_at`、`queue_expires_at`（排队超时的时间，没有设置排队超时为 `null`）。`runs.list` 里每个运行、`dashboard.get` 的 `running_runs` 里每个运行都带 `active_nodes`，是它进行中的节点（`status` 为 `queued`、`dispatched`、`running` 或 `waiting`），每项带 `chain_instance_id`、`node_id`、`display_name`、`attempt`、`agent`（任务所在的 Agent，排队中的是它在等的 Agent，不在 Agent 上执行的节点为 `null`）、`started_at`（还没开始执行时为 `null`）和 `progress`（`current` 和 `total`）。有了这些，自建的看板不用逐个运行去读运行视图，就能画出每台 Agent 的槽位里是哪个节点在做什么，也能列出每个运行此刻进行到哪。
- 时间字段都是控制面时间，格式是 ISO 8601 字符串。
- 控制台里运行监控页的地址是 `{{SFLY_URL}}/runs/<运行 id>`，看板上需要深入排查时链接过去。地址可以带 `view=overview`（概览，关注项和链路）或 `view=detail`（详情，时间线、图表和日志）指定打开哪个视图，不带 `view` 时，给了 `node`、`tab` 或 `at` 就打开详情，没给的话失败和取消的运行打开详情，其余打开浏览器上次停留的视图（默认概览）；写了 `view=overview` 时，`node` 用来在概览里标出属于这个节点的关注项，`tab`、`at` 只在详情里有效。地址可以带 `node=<节点 ID>` 选中一个节点，再加 `tab=logs`（或 `actions`、`attempts`、`io`、`artifacts`）切到底部面板的页签；带了 `node` 之后还可以加 `at=<时刻>`（控制面时间，ISO 8601 的 UTC 写法，如 `2026-01-01T00:00:06.250Z`，和接口返回的时间同一种）：日志定位到包含那一刻的一页，那一刻正好有一行（相差 50 毫秒以内，并且只有这一行）就高亮它，没有就在那个位置标出「这一刻」。

## 预检并触发

```ts
const check = await client.runs.preflight({ params: { id: scenario.id } });
for (const param of check.params) {
	console.log(param.name, param.type, param.required ? "必填" : "可选", param.default);
}
if (check.problems.length > 0) {
	for (const problem of check.problems) console.warn(problem.code, problem.message);
	throw new Error("场景现在不能触发");
}

const run = await client.runs.trigger({
	params: { id: scenario.id },
	body: { params: { host: "api.test", rounds: 3 } },
});
console.log(`已触发：{{SFLY_URL}}/runs/${run.id}`);
```

按运行预设触发：从预检返回的 `presets` 里按名称找到预设，把它的 ID 放进 `preset`，`params` 只给其余的参数。

```ts
const preset = check.presets.find((p) => p.name === "压测 A 集群");
if (!preset) throw new Error("没有这个运行预设");
const presetRun = await client.runs.trigger({
	params: { id: scenario.id },
	body: { preset: preset.id, params: { rounds: 3 } },
});
console.log(presetRun.preset?.name, presetRun.preset?.params);
```

- `runs.preflight` 返回最新的场景版本号、入口参数的声明（名称、类型、默认值、是否必填、是否 secret；secret 参数的默认值是占位符 `******`）、不能触发的原因（`problems`，为空表示可以触发）、不阻断触发但值得留意的警告（`warnings`，结构同 `problems`，例如 `subflow_param_not_passed`：异步任务节点没有给子流程的参数传值，而子流程里有节点用到它），锁定的节点包版本和引用的 Agent 是否在线，以及场景的运行预设（`presets`，按名称排序，和 `presets.list` 相同）。`agents` 里每台 Agent 的 `status` 是 `online`、`offline` 或 `unknown`（还没有注册过），`preparing_since` 是它这次连接开始准备环境的时间，准备好、不在线或没有注册过时为 `null`。Agent 不在线、正在准备环境都不阻止触发：任务会排队，Agent 上线或准备好环境后再执行。触发页面可以按 `params` 生成表单，按 `problems` 提示问题，按 `warnings` 提醒。`problems` 里还有 `dev_package_not_loaded`：节点用的开发版本（`包名@dev`）没有在它派发到的在线 Agent 上加载。`warnings` 里还有 `secret_params_too_large`：场景里 secret 参数的默认值、或某个运行预设的值，合计已经超过上限（所有写法合计 1048576 个字符，见 [运行场景](run-scenario.md)「secret 参数的大小上限」），照这些值触发会被拒绝（触发时给更小的值就能触发）；写明是默认值还是哪个运行预设、合计约多少（取整到千）、占得最多的参数，不含值。这一项带结构化的 `origin`：`{ kind: "defaults", preset_ids }`（默认值；`preset_ids` 是 secret 值和默认值完全相同、用它们触发用的也是默认值的预设）或 `{ kind: "preset", preset_id }`（某个预设），触发页面据此只显示和当前选择有关的那一条。触发时改不了的值（子流程里节点传的常量、子流程入口节点上的默认值）超限时，同一个 `code` 在 `problems` 里（阻断项，带子流程入口节点的 `node_id`），说明指出要改场景。
- `runs.trigger` 触发场景的最新版本，不能指定版本。参数按入口参数声明的类型给：`number` 给数字，`boolean` 给 `true` 或 `false`，`json` 给对象、数组这类 JSON 值。返回新运行的运行视图。
- 预检没通过时触发失败，错误码 `invalid_orchestration`，`details` 是原因列表（节点上写了节点类型没有声明的输入名时有 `input_not_declared`，保存场景时同一条出现在响应的 `warnings` 里）；参数不对时错误码 `invalid_params`，其中入口参数整个接到某个节点的输入、值的类型不符时（例如小数接到 `integer` 输入，8 和 8.0 都是整数）`details` 里的 `code` 是 `param_input_type_mismatch`。这次触发的 secret 参数的值合计太大（所有写法合计超过 1048576 个字符）时 `details` 里的 `code` 是 `secret_params_too_large`，`message` 分三行写明原因（合计约多少、取整到千，上限多少）、占得最多的参数和怎么办（缩短这些值，或只把真正要打码的字段单独做成 secret 参数），不含值，不产生运行。
- 运行预设固定了一部分参数的值（预设参数），带上 `preset` 时控制面用预设的值填入它们，`params` 里不用再给。给 secret 预设参数传了任何值（和预设里的值相同也一样）、给其他预设参数传了和预设不同的值时触发失败，错误码 `preset_param_locked`，`details` 是 `{ param, preset }`（参数名和预设名）；给其他预设参数传相同的值照常触发。预设不存在或不属于这个场景时错误码 `preset_not_found`；预设已失效时错误码 `preset_invalid`，`details` 是问题清单（每项 `{ param, reason }`），不产生运行。运行视图的 `preset` 记着触发时预设的 ID、名称和预设参数的名单，没用预设时为 `null`。
- 失效的运行预设：最新版本里预设参数已不存在（`reason` 是 `missing`），或保存的值不符合它现在的类型（`type_mismatch`）时，预设失效，不能用来触发；最新版本新增参数，参数的默认值、是否必填、是否 secret 有变化，都不影响预设。`presets.list` 和 `runs.preflight` 返回的每个预设带 `status`（`ok` 或 `invalid`）和 `problems`（每项 `{ param, reason, message }`：`reason` 给代码分支用，`message` 是写好的一句话，例如「参数 host 已不存在」，可以直接显示），触发页面可以据此禁用失效的预设、写明原因。保存场景版本时，会让预设失效的改动在响应的 `warnings` 里各有一条 `code` 为 `preset_invalidated` 的警告，写明预设名和原因，不阻止保存。失效的预设可以只改名称和说明；改好预设参数（`presets.update` 给出完整清单，对照最新版本通过）以后恢复可用。
- 新建运行预设用 `presets.create({ params: { id }, body: { name, description, params: [{ name, value }] } })`，列出用 `presets.list`。值按参数声明的类型给，至少一个参数；不符合时错误码 `invalid_preset`，`details` 指出是哪个字段、什么原因，名称重复时错误码 `preset_name_taken`。
- secret 参数也能设为预设参数，值明文保存，但所有响应里都只返回打码后的值：预设视图里这个参数的 `secret` 是 `true`，`value` 是 `******`。是不是 secret 以最新版本的声明为准。修改时不想重新输入的 secret 参数写成 `{ name, keep: true }`，沿用预设里原来的值，例如 `params: [{ name: "host", value: "b.example" }, { name: "api_token", keep: true }]`；`keep` 只能用在最新版本里声明为 secret、预设里已经有值的参数上（新建时没有原值，不能用），否则错误码 `invalid_preset`。
- 修改、复制、删除运行预设用 `presets.update`、`presets.copy`、`presets.remove`，路径参数是 `{ id, presetId }`。`update` 的请求体只写要改的项，至少一项：没有 `params` 时只改名称和说明（失效的预设也可以改名），给了 `params` 时它是预设参数的完整清单，规则和新建相同；`copy` 的请求体是 `{ name }`（新名称），说明和预设参数原样复制；`remove` 没有返回值。预设不存在或不属于这个场景时错误码 `preset_not_found`，名称重复时 `preset_name_taken`。预设可以随时修改，场景归档期间也一样，改了立即生效；已经开始的运行不受影响。复制场景时预设一并复制。
- 取消运行用 `runs.cancel({ params: { id } })`。清理期间再取消一次就是强制取消。运行已经结束时错误码 `run_not_running`。

## 订阅运行

```ts
const stop = client.runs.events(
	{ params: { id: run.id } },
	{
		run: (view) => {
			console.log("运行状态", view.status);
			if (view.status !== "running") stop();
		},
		progress: (event) => console.log(event.node_id, event.progress.current, event.progress.total),
	},
	{
		onOpen: () => console.log("连上了：首次连接或断线重连"),
		onError: (error) => console.error("订阅停止", error.code, error.message),
	},
);
```

- 连上时，以及运行或任何节点的状态变化时，事件 `run` 推送完整的运行视图（和 `runs.get` 同一份，大的输入、输出同样只给大小）；执行中的节点此刻在做的动作（`current_action`，见「读节点正在做的事」）换了时也推送。`progress` 是一个任务的最新进度，`metrics` 是执行中的任务新上报的指标点（每个任务每秒最多一条）。每类事件的数据都有类型，只写关心的事件。
- 断线、连不上或控制面返回 5xx 时自动重连。间隔是控制面在流里建议的值（没有时 1 秒），连续失败时翻倍，最多 15 秒。重连后控制面先推一次完整的运行视图，页面不会停在旧状态。
- 连上之后连着 45 秒一个字节也没收到（控制面每 15 秒在每条流里写一条心跳，三次没到）就当作连接已经死了，自己断开重连：中间的设备悄悄丢了连接（休眠醒来、网络切换、NAT 表项过期，没有 FIN 也没有 RST）时没有任何事件通知客户端，不设这一道就永远等下去。重连带最后一条消息的 id，断线期间的持久事件补发。反向代理的空闲超时比 15 秒长时不受影响（心跳让流从来不空闲）；比 15 秒短时每次空闲都被切、每次自动重连。
- `onOpen` 在首次连上和每次重连后各调用一次。断线期间错过的指标点不会补发，在这里用 `metrics.series` 重新查询。
- 控制面返回 4xx（例如运行不存在）或者响应不是事件流时，订阅停止，不再重连，调用 `onError`。
- 运行结束后事件流不会自己断开。拿到结束的状态后调用返回的关闭函数，页面离开时也要调用。关闭函数可以重复调用。

## 读日志

```ts
const latest = await client.logs.runPage({
	params: { id: run.id },
	query: { limit: 200, level: "warn,error" },
});
for (const line of latest.lines) console.log(line.time, line.level, line.node_id, line.text);

if (!latest.reached_start) {
	const earlier = await client.logs.runPage({
		params: { id: run.id },
		query: { before: latest.before, level: "warn,error" },
	});
	console.log(`往前又读到 ${earlier.lines.length} 行`);
}

const stopLogs = client.logs.runEvents(
	{ params: { id: run.id }, query: { after: latest.live_after, level: "warn,error" } },
	{
		logs: (chunk) => {
			for (const line of chunk.lines) console.log(line.time, line.level, line.node_id, line.text);
		},
		reload: () => {
			stopLogs();
			console.log("要补发的行太多：从最新一页重新读，再用新的 live_after 订阅");
		},
	},
);
```

- `logs.runPage` 读一次运行全部任务合并的日志，按控制面时间排序。不给游标时读最新的一页（`limit` 默认 200，最多 1000）。`before` 往前翻，`after` 往后接。
- 一页可能不满 `limit` 行，筛选级别时甚至可能是空的，这不表示读完了。看 `reached_start` 和 `reached_end`，没到就用 `before` 或 `after` 接着读。
- `level`（例如 `warn,error`）在控制面上筛选。游标只对同一组筛选条件有效，换了条件就从最新一页重新读。
- `logs.runEvents` 从最新一页的 `live_after` 接上实时推送：之后写入的行，包括之后才开始的任务的行，都会送达，和读过的页不重复、不遗漏。断线重连后从断点继续。积压的行太多时控制面不逐行补发，推送 `reload`，这时从最新一页重新读。
- 只看一个任务的日志用 `logs.page` 和 `logs.events`（`after_seq` 填分页返回的 `last_seq`）。
- 日志是被测系统产生的数据。显示时当作文本（`textContent`），不要当作 HTML 插进页面。

## 读节点正在做的事

节点用 `ctx.action` 记录的动作，写法见 [开发节点](sdk-reference.md) 的「`ctx.action` 与 `ctx.mark`」一节：

```ts
const live = await client.runs.get({ params: { id: run.id } });
for (const node of live.chains.flatMap((chain) => chain.nodes)) {
	const attempt = node.attempts.at(-1);
	if (!attempt?.current_action) continue;
	console.log(node.node_id, "正在做", attempt.current_action.name, attempt.current_action.started_at);
	const actions = await client.actions.summary({ params: { id: attempt.task_id } });
	for (const action of actions.running) console.log("  ".repeat(action.depth), action.name, action.fields);
	for (const failed of actions.recent_failed) console.log("失败", failed.name, failed.reason);
}
```

- 运行视图里执行中的尝试带 `current_action`：最外层、开始得最早的那个正在做的动作，写名称和开始时间（控制面时间）。没有正在做的最外层动作、尝试已经结束时为 `null`。Agent 列表里正在执行的任务（`running_tasks`）也带它，还带 `progress`：这次尝试最新的进度（`ctx.progress`），和运行视图里同一次尝试的相同，没上报过时为 `null`。
- `actions.summary` 读一个任务（一次尝试）的动作摘要：每种名称的个数（动作和标记合计）和失败的动作数（`names`，最多 1000 种，名称很长时更少，从什么时候起只计数写在 `capped_at`；名称表没列全时 `names_complete` 为 `false`，没列出的名称合在一起的个数、失败数、有明细的个数在 `unlisted`）、全部名称合计的失败数（`failed_total`：没列出的名称的失败不在 `names` 各项里，别自己把各项加起来）、正在做的动作（`running`，带层级，最多 50 个，没列全时 `running_complete` 为 `false`）、最近结束的 20 个动作和最近失败的 5 个动作（摘要因为太大省去了一些时 `lists_trimmed` 为 `true`），以及动作和标记的合计数、有没有超出上限（`capped`）。任务结束以后 `running` 为空，其余照旧。
- 摘要是节点每秒最多上报一次的那一份，不是实时的每一个动作。字段和失败原因是节点写的数据，显示时当作文本。

每一个动作和标记的明细按任务分页读，再接上实时推送：

```ts
const task = live.chains[0]?.nodes.at(-1)?.attempts.at(-1)?.task_id;
if (task) {
	const latest = await client.actions.page({ params: { id: task }, query: { limit: 100 } });
	for (const detail of latest.actions) {
		const result = detail.kind === "action" ? (detail.result ?? "进行中") : "标记";
		console.log(detail.started_at, "  ".repeat(detail.depth), detail.name, result, detail.fields);
	}
	for (const period of latest.count_only) console.log(period.from, period.name, `${period.count} 个只计数`);
	if (latest.before) {
		const earlier = await client.actions.page({
			params: { id: task },
			query: { before: latest.before, limit: 100 },
		});
		console.log(`往前又读到 ${earlier.actions.length} 个`);
	}
	const failed = await client.actions.page({ params: { id: task }, query: { failed: "true" } });
	for (const detail of failed.actions) if (detail.kind === "action") console.log("失败", detail.reason);

	const stopActions = client.actions.events(
		{ params: { id: task }, query: { after: latest.rev } },
		{
			summary: (summary) => console.log("正在做", summary.running.length, "个"),
			actions: (chunk) => {
				for (const detail of chunk.actions) console.log("更新", detail.id, detail.name);
			},
		},
	);
	window.addEventListener("pagehide", stopActions);
}
```

- `actions.page` 按开始时间从新到旧分页（`limit` 默认 100，最多 500），`before` 往前翻，没有更早的明细时为 `null`。`name` 只要一种名称，`failed` 为 `true` 时只要失败的动作。
- 进行中的动作 `result` 为 `null`。任务结束（成功、失败、取消、`agent_lost`）时还没结束的记为 `unfinished`，结束时间取任务的结束时间；任务结束以后才到的明细不再记下，所以 `unfinished` 不会再变。
- 超过上限（每种名称 5 万个，合计 10 万个，失败的动作不受每种名称的限制）以后只计数、没有明细：`count_only` 写出这一页范围里哪种名称从什么时候起有多少个没有明细、为什么（`reason`）。一直往前翻，每一段正好出现一次。
- `actions.events` 从分页返回的 `rev` 接上实时推送：连上时先推一份摘要，之后推送新写入和刚结束的明细（同一个 `id` 再出现时以后到的为准），每份新的摘要也推送；任务结束时推送正在做的为空的摘要和记为未结束的明细。断线重连后从断点继续，不重复、不遗漏。

## 下载产物

```ts
const finished = await client.runs.get({ params: { id: run.id } });
for (const chain of finished.chains) {
	for (const node of chain.nodes) {
		for (const attempt of node.attempts) {
			const { artifacts } = await client.artifacts.list({ params: { id: attempt.task_id } });
			for (const artifact of artifacts) {
				const link = document.createElement("a");
				link.href = client.artifacts.download({
					params: { id: attempt.task_id, "*": artifact.name },
				});
				link.textContent = `${chain.name ?? "主链"} / ${node.node_id}：${artifact.name}`;
				document.body.append(link);
			}
		}
	}
}

const logLink = document.createElement("a");
logLink.href = client.logs.runDownload({ params: { id: run.id } });
logLink.textContent = "下载整次运行的日志";
document.body.append(logLink);
```

- 产物属于任务（节点的一次尝试）。任务 id 在运行视图里每次尝试的 `task_id`。
- `artifacts.download`、`logs.runDownload` 这类下载方法只拼出地址，不发请求。把地址放进链接，用户点一下就能下载。`baseUrl` 是完整地址时，拼出的也是完整地址。
- 产物列表里的 `url` 字段是给 Agent 用的地址，页面里用 `artifacts.download` 拼出的地址。
- `logs.runDownload` 下载整次运行合并后的日志（JSONL），`logs.download` 下载一个任务的原始日志。
- 运行超过保留期被清理后，产物列表的 `expired` 为 `true`、列表为空，下载地址返回 410，错误码 `expired`。

## 错误处理

```ts
import { ApiError } from "@sfly/client";

try {
	await client.runs.cancel({ params: { id: run.id } });
} catch (error) {
	if (!(error instanceof ApiError)) throw error;
	switch (error.code) {
		case "network_error":
			console.error("控制面不可达", error.details);
			break;
		case "run_not_running":
			console.log("运行已经结束了");
			break;
		default:
			console.error(error.status, error.code, error.message, error.method, error.path);
	}
}
```

所有失败都抛出同一种错误 `ApiError`：`status` 是 HTTP 状态，`code` 是错误码，还有 `message`（说明）、`details`（详情）、`method` 和 `path`（相对控制面地址的请求路径）。

| 错误码 | 含义 |
|---|---|
| `network_error` | 没有收到响应，`status` 为 0：控制面不可达、连接断开，或者浏览器拦下了跨域请求 |
| `nickname_required` | 不是 GET 的请求既没有令牌也没有昵称，请求没有发出去，`status` 是 400（和控制面对这种请求的回复一致）；错误码是旧名字，信息里写明要给 `token` |
| `http_error` | 错误响应不是控制面的格式，例如中间的代理返回的页面；`details` 是响应体 |
| `invalid_response` | 成功的响应格式不对，例如 JSON 接口返回的不是 JSON |
| 其他 | 控制面返回的错误码，例如 `not_found`、`invalid_params`、`invalid_orchestration`、`run_not_running`；每个方法的说明里写着它会返回哪些 |

- 浏览器拦下的跨域请求和断网一样是 `network_error`：浏览器不告诉页面原因，原因在浏览器开发者工具的控制台里。
- JSON 接口的方法最后都可以传 `{ signal }` 中止请求。中止后调用以中止的原因失败，不是 `ApiError`。

## 控制面时间

运行的开始时间、结束时间都是控制面时间。浏览器的时钟可能不准，用它算「已经运行了多久」会和控制台对不上。每个响应都带着控制面的当前时间，用 `onControlPlaneTime` 接收：

```ts
let clockOffsetMs = 0;
const timedClient = createClient({
	baseUrl: "{{SFLY_URL}}",
	onControlPlaneTime: (time) => {
		clockOffsetMs = Date.parse(time) - Date.now();
	},
});
const elapsedMs = (startedAt: string) => Date.now() + clockOffsetMs - Date.parse(startedAt);

const { runs: running } = await timedClient.runs.list({
	params: { project: "default" },
	query: { status: "running" },
});
for (const item of running) console.log(item.id, `已运行 ${Math.round(elapsedMs(item.started_at) / 1000)} 秒`);
```

事件流订阅期间，控制面定时推送的时间也交给同一个回调。

## 跨域

控制面默认允许所有来源的页面跨域调用，不带 Cookie 之类的凭据。自建页面部署在任何地址都能直接调用控制面，本地开发时从 `localhost` 也可以，不用配开发代理或转发服务。

- 每个请求都带 `x-sfly-client` 请求头，所以跨域时浏览器先发一个预检请求（`OPTIONS`）。控制面让浏览器把预检的结果缓存 10 分钟。
- 页面能读到控制面的版本和时间两个响应头，版本警告和控制面时间在浏览器里同样生效。

**「允许所有来源」意味着什么。** 现在不带令牌的请求照旧放行（强制鉴权在 #494）。在那之前，内网用户在浏览器里打开的任何网页，都能不带凭据调用他访问得到的控制面，包括触发和取消运行、增删飞书机器人；写操作的昵称也可以随便填。带令牌的请求按令牌的范围检查，不受这条影响；控制台的登录 Cookie 只认同源的请求，别的网页借不到。飞书机器人的 Webhook 地址在接口里本来就是打码的。

**收窄成名单。** 部署控制面的人设置环境变量 `SFLY_CORS_ORIGINS`，写逗号分隔的来源，每一项是「协议://主机[:端口]」，例如 `https://dash.example.com,http://localhost:5173`，重启控制面后生效。

- 设置之后只有名单里的来源能调用，名单外的页面被浏览器拦下，页面里得到 `network_error`。
- 名单里有一项写的不是来源（例如漏了 `https://`）时，控制面启动失败，不会悄悄变成谁也调不通。
- 名单只对浏览器起作用，不是鉴权：命令行、脚本和 Agent 不经过浏览器，不受它限制。控制台自己的页面和控制面同源，也不受影响。

## 公网页面访问内网的控制面

自建页面托管在内网，或者在本机用 `localhost` 开发时，Chrome 不限制它调用内网的控制面，不弹提示，HTTP 的页面也可以。

自建页面托管在公网（例如公网上的静态网站托管服务）、控制面在内网时，Chrome 按「本地网络访问」（Local Network Access，Chrome 142 起默认开启）限制公网页面访问内网地址：

- 页面必须是 HTTPS。HTTP 的公网页面调用内网的控制面，请求直接失败，页面里是 `network_error`，没有提示。
- 第一次调用时，Chrome 在地址栏下弹出提示「<页面的来源> 想要访问本地网络中的其他设备」，按钮是「屏蔽」和「允许」。用户选择之前请求一直等着。允许之后读、写和订阅事件流都正常；屏蔽之后一直是 `network_error`。这个选择按页面的来源记在 Chrome 的网站设置里，以后可以在那里改。
- 控制面的地址要让 Chrome 在发请求之前就知道它在内网：写内网 IP（例如 `http://10.0.0.5:8080`）或者 `.local` 域名。写成解析到内网 IP 的普通域名（例如 `http://sfly.corp:8080`）时，Chrome 把请求当作混合内容直接拦下，用户允许了也没用。这时在传给 API 客户端的 `fetch` 里标明目标在本地网络：

```ts
const intranetClient = createClient({
	baseUrl: "http://sfly.corp:8080",
	token: "sfly_pat_…",
	fetch: (url, init) => fetch(url, { ...init, targetAddressSpace: "local" } as RequestInit),
});
```

- 页面可以先查询这个权限：`navigator.permissions.query({ name: "local-network" })` 的结果是 `prompt` 时，先在页面上说明为什么要访问内网；是 `denied` 时，告诉用户去网站设置里改成允许。
- 下载地址放进链接，用户点击下载属于页面跳转，不受这项限制。
- 控制面不需要额外的配置。以前「私有网络访问」（Private Network Access）的 `Access-Control-Allow-Private-Network` 响应头已经不用了，Chrome 的预检里也不再问它。
- 公司统一管理的 Chrome 可以用企业策略 `LocalNetworkAllowedForUrls`（Chrome 146 起）预先允许自建页面的来源，用户就不会看到提示。这一条来自 Chrome 的文档，没有实测。

以上在 2026 年 11 月核实：macOS 上的 Google Chrome 157.0.8103.51，以及 Chrome for Testing 156.0.8078.4（无界面运行时不弹提示，按屏蔽处理）。Firefox 和 Safari 没有核实。

## 版本与兼容

- API 客户端和控制面同一个版本号、一起发布。按本页的命令从控制面安装，装到的就是控制面的版本。
- 1.0 之前不保证跨版本兼容。控制面升级后，接口的路径、字段和含义可能变化，不兼容的变化写在发版说明里。
- 版本不一致时，每个客户端实例在第一次收到控制面的响应时警告一次，写明两边的版本和从控制面重新安装的命令，请求照常进行。`baseUrl` 是路径（同源页面）时没有可复制的地址，警告只写办法，不带命令。默认用 `console.warn`，也可以自己接收，显示在页面上：

```ts
import { CLIENT_VERSION } from "@sfly/client";

const checkedClient = createClient({
	baseUrl: "{{SFLY_URL}}",
	onVersionMismatch: (mismatch) => {
		document.title = `API 客户端 ${mismatch.clientVersion} 与控制面 ${mismatch.controlPlaneVersion} 版本不一致`;
	},
});
console.log("API 客户端版本", CLIENT_VERSION, await checkedClient.system.health());
```

处理办法：读发版说明里不兼容的变化，重新运行警告里给出的安装命令（和本页的一样），改代码、重新构建并部署页面。

## 做不到的事

API 客户端只开放平台现有的接口，下面这些没有：

- **没有事件推送和对外的 Webhook。** 只能订阅一次运行的事件流。要发现新的运行，定时查询 `runs.list`。要在运行失败或被取消时发到飞书群，用场景的运行通知；日常的结果（成功时的汇总、指标）在节点代码里用 `ctx.notify` 发，见 [飞书通知](feishu-notify.md)。
- **不能跨运行查询指标。** 指标只能按一次运行查询（`metrics.summary`、`metrics.series`）。要看多次运行的趋势，逐次查询后自己汇总。
- **运行列表不能按时间范围查询，也不能翻页。** `runs.list` 只返回最新的最多 500 条，`runs.listForOrchestration` 最多 200 条。
- 入口参数没有说明和可选项。
- 不能上传：发布节点包用 `sfly publish`，见 [发布](publish.md)。
- 强制鉴权之前，不带令牌的请求仍然放行，身份只是昵称（已弃用）；带了令牌，身份和权限由令牌决定。
