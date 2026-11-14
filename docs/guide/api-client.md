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
	nickname: () => localStorage.getItem("sfly-nickname"),
});
```

- `baseUrl` 是控制面地址。API 客户端直接调用控制面根路径上的接口，地址后面不加 `/api`。
- `nickname` 是昵称，控制面把它记为触发人、作者、取消人。可以给固定的字符串，也可以给一个函数，每次请求时取值，中文也可以。平台没有登录，昵称不做校验。
- 创建客户端时可以不给昵称，只读的页面用不到它。但每个不是 GET 的请求（触发、取消运行，保存场景版本，增删飞书机器人……）都要昵称，包括 `agents.updateNow` 这类控制面本身不检查昵称的接口。没有昵称（函数返回空值或空白）时，这些调用在发请求之前就失败，错误码 `nickname_required`。
- `fetch` 可选：换成自己的实现，例如测试替身，或者经过自己的代理。默认用全局的 `fetch`。
- 每个请求都带请求头 `x-sfly-client: sfly-client/<版本>`。

方法按领域分组，领域名和方法名沿用 HTTP 接口的契约，每个方法对应 `sfly api --list` 列出的一个接口。场景在接口里还叫 `orchestrations`，字段名是 `orchestration_id`。

| 领域 | 方法 |
|---|---|
| `orchestrations`（场景） | `list`、`get`、`head`、`versions`、`version`、`saveVersion`、`restoreVersion`、`create`、`update`、`copy`、`archive`、`unarchive` |
| `presets`（运行预设） | `list`、`create`、`update`、`copy`、`remove` |
| `runs`（运行） | `list`、`listForOrchestration`、`preflight`、`trigger`、`get`、`cancel`、`events` |
| `logs`（日志） | `runPage`、`runEvents`、`runDownload`、`page`、`events`、`download` |
| `metrics`（指标） | `summary`、`catalog`、`series`、`platform` |
| `artifacts`（产物） | `list`、`download` |
| `agents`（sfly Agent） | `list`、`updateNow` |
| `packages`（节点包） | `list`、`get`、`version`、`nodeType` |
| `feishuBots`（飞书机器人） | `list`、`create`、`replaceWebhook`、`references`、`remove`、`test` |
| `dashboard`（控制台统计） | `get` |
| `system` | `health` |

调用的输入是一个对象：`params` 是路径参数，`query` 是查询参数，`body` 是请求体，和契约声明的一致。返回值是契约的响应类型。下面的例子从上到下是一个连贯的脚本：真实页面里，把它们放进按钮的点击事件或定时刷新里。

## 查询场景和运行

```ts
const { orchestrations } = await client.orchestrations.list({ query: { q: "回归" } });
const scenario = orchestrations.find((s) => s.name === "回归");
if (!scenario) throw new Error("没有找到场景「回归」");
console.log(scenario.last_run?.status ?? "还没有运行过", scenario.agents);

const { runs, counts } = await client.runs.list({
	query: { orchestration_id: scenario.id, limit: 20 },
});
console.log(`失败 ${counts.failed} 次`);
for (const item of runs) {
	console.log(item.id, item.status, item.triggered_by, item.started_at);
	console.log(`在控制台里看：{{SFLY_URL}}/runs/${item.id}`);
}
```

- `orchestrations.list` 列出没有归档的场景，按新建时间从新到旧。`q` 按名称、说明或引用的 Agent 搜索，`status` 按最近一次运行的状态筛选，`agent` 只看引用了这个 Agent 的场景。每一项带着最近一次运行和各节点的状态（`last_run`）、引用的 Agent 和它们是否在线（`agents`），看板画场景卡片只要这一次请求。
- `runs.list` 列出所有场景的运行，按开始时间从新到旧，最多 `limit` 条（默认 200，最多 500）。可以按 `status`、`orchestration_id` 筛选，`q` 按运行编号前缀或触发人搜索。`counts` 是各状态的运行数。
- `runs.get` 读一次运行的完整视图：各条链、各个节点的状态，每次尝试的错误和输出。
- 控制台统计用 `dashboard.get`，Agent 的在线状态和版本用 `agents.list`（`preparing_since` 不为空表示 Agent 在线但还在准备环境、不接任务），一次运行的指标摘要、图表声明和序列用 `metrics.summary`、`metrics.catalog`、`metrics.series`。
- 时间字段都是控制面时间，格式是 ISO 8601 字符串。
- 控制台里运行监控页的地址是 `{{SFLY_URL}}/runs/<运行 id>`，看板上需要深入排查时链接过去。

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

- `runs.preflight` 返回最新的场景版本号、入口参数的声明（名称、类型、默认值、是否必填、是否 secret）、不能触发的原因（为空表示可以触发），锁定的节点包版本和引用的 Agent 是否在线，以及场景的运行预设（`presets`，按名称排序，和 `presets.list` 相同）。`agents` 里每台 Agent 的 `status` 是 `online`、`offline` 或 `unknown`（还没有注册过），`preparing_since` 是它这次连接开始准备环境的时间，准备好、不在线或没有注册过时为 `null`。Agent 不在线、正在准备环境都不阻止触发：任务会排队，Agent 上线或准备好环境后再执行。触发页面可以按 `params` 生成表单，按 `problems` 提示问题。
- `runs.trigger` 触发场景的最新版本，不能指定版本。参数按入口参数声明的类型给：`number` 给数字，`boolean` 给 `true` 或 `false`，`json` 给对象、数组这类 JSON 值。返回新运行的运行视图。
- 预检没通过时触发失败，错误码 `invalid_orchestration`，`details` 是原因列表；参数不对时错误码 `invalid_params`。
- 运行预设固定了一部分参数的值（预设参数），带上 `preset` 时控制面用预设的值填入它们，`params` 里不用再给。给了和预设不同的值时触发失败，错误码 `preset_param_locked`，`details` 是 `{ param, preset }`（参数名和预设名）；给相同的值照常触发。预设不存在或不属于这个场景时错误码 `preset_not_found`。运行视图的 `preset` 记着触发时预设的 ID、名称和预设参数的名单，没用预设时为 `null`。
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

- 连上时，以及运行或任何节点的状态变化时，事件 `run` 推送完整的运行视图。`progress` 是一个任务的最新进度，`metrics` 是执行中的任务新上报的指标点（每个任务每秒最多一条）。每类事件的数据都有类型，只写关心的事件。
- 断线、连不上或控制面返回 5xx 时自动重连。间隔是控制面在流里建议的值（没有时 1 秒），连续失败时翻倍，最多 15 秒。重连后控制面先推一次完整的运行视图，页面不会停在旧状态。
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
| `nickname_required` | 不是 GET 的请求没有昵称，请求没有发出去，`status` 是 400（和控制面对这种请求的回复一致） |
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

const { runs: running } = await timedClient.runs.list({ query: { status: "running" } });
for (const item of running) console.log(item.id, `已运行 ${Math.round(elapsedMs(item.started_at) / 1000)} 秒`);
```

事件流订阅期间，控制面定时推送的时间也交给同一个回调。

## 跨域

控制面默认允许所有来源的页面跨域调用，不带 Cookie 之类的凭据。自建页面部署在任何地址都能直接调用控制面，本地开发时从 `localhost` 也可以，不用配开发代理或转发服务。

- 每个请求都带 `x-sfly-client` 请求头，所以跨域时浏览器先发一个预检请求（`OPTIONS`）。控制面让浏览器把预检的结果缓存 10 分钟。
- 页面能读到控制面的版本和时间两个响应头，版本警告和控制面时间在浏览器里同样生效。

**「允许所有来源」意味着什么。** 平台没有登录。内网用户在浏览器里打开的任何网页，都能调用他访问得到的控制面，包括触发和取消运行、增删飞书机器人；写操作的昵称也可以随便填。飞书机器人的 Webhook 地址在接口里本来就是打码的。

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
	nickname: "张三",
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

- **没有事件推送和对外的 Webhook。** 只能订阅一次运行的事件流。要发现新的运行，定时查询 `runs.list`。要把运行结果发到飞书群，用场景的运行通知或飞书通知节点，见 [飞书通知](feishu-notify.md)。
- **不能跨运行查询指标。** 指标只能按一次运行查询（`metrics.summary`、`metrics.series`）。要看多次运行的趋势，逐次查询后自己汇总。
- **运行列表不能按时间范围查询，也不能翻页。** `runs.list` 只返回最新的最多 500 条，`runs.listForOrchestration` 最多 200 条。
- 入口参数没有说明和可选项。
- 不能上传：发布节点包用 `sfly publish`，见 [发布](publish.md)。
- 没有登录和权限，身份只是昵称。
