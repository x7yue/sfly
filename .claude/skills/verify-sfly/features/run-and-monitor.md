# 运行与监控

用户在场景上点「运行」，打开运行抽屉，填好入口参数并通过「触发前检查」后触发。抽屉里实时显示各链的进度、正在执行的节点和最新日志。在运行详情页（`/runs/<id>`）可以看链路时间线，底部面板有日志、输入输出、尝试、产物。「运行记录」页列出历史运行。

## Sub-features

- `run-drawer`：运行抽屉，里面有入口参数、触发前检查，以及「取消」和「触发运行」按钮。
- `run-trigger`：触发后抽屉切到运行摘要，实时更新，结束时显示「成功」或「失败」以及耗时。
- `run-detail`：运行详情页，有链路时间线和底部面板（日志、输入输出、尝试、产物）。
- `run-list`：运行记录页，卡片视图里是运行中的，表格「历史运行」里是已结束的。
- `run-cancel`：运行中可以取消；在清理阶段再次取消就是强制取消。

## How to get to it (user POV)

- 画布顶部的「运行」按钮。
- 场景编排页的场景卡片上的「运行」按钮，打开 `dialog "运行 · <场景名>"`。
- 抽屉底部的链接「打开运行详情」，或者运行记录页卡片上的同名链接。
- 侧边栏「运行记录」（`/runs`）。

## Driving it with agent-browser

Preconditions:

- 已经按 [编排场景](./edit-scenario.md) 保存了「验证回显」的 v1：`echo_1` 节点，`text` 填的是 `"你好 sfly"`，默认 Agent 是 `verify-agent`。

- **打开抽屉。** 在画布上点 `button "运行"`，出现标题「运行 · 验证回显」，里面有「入口参数 0 个」和「触发前检查」两块，还有 `button "触发运行"`。截图 `run-01-drawer.png`。
- **触发。** 点 `button "触发运行"`。运行结束要轮询 API，等到 `curl -s $HTTP_URL/api/runs` 里这次运行的 `status` 变成 `success`，本机通常不到 1 秒。抽屉显示 `成功 <运行ID前8位> <耗时>`，「主链 2/2」，「运行已结束：成功。」截图 `run-02-finished.png`。
- **副作用。** `curl -s $HTTP_URL/api/runs/<运行ID> > $RUN/evidence/run-run.json`，里面 `chains[0].nodes` 中 `echo_1` 的 `outputs` 应该是 `{"text":"你好 sfly"}`，`triggered_by` 是浏览器里填的昵称。再看 `/api/agents`，`installed_packages` 里有 `sfly-stub 0.1.0`，说明 Agent 从控制面装好了这个包。
- **运行详情。** 运行 `find role link click --name "打开运行详情"`，URL 变成 `/runs/<运行ID>`，能看到 `region "链路时间线"` 和 `region "底部面板"`。点底部面板的 `tab "输入输出"`，应该看到 `text` 的值 `你好 sfly`。截图 `run-03-detail.png`。
- **运行记录。** 打开 `$HTTP_URL/runs`，`table "历史运行"` 里有一行包含运行 ID 的前 8 位，状态是成功。

## Gotchas

- 「打开运行详情」是链接，不是按钮：`find role button` 找不到它。
- 抽屉在弹出层里，`snapshot -c` 的文字里不一定有「成功」，不要靠 grep snapshot 来等运行结束，要轮询 API。
- `echo` 不写日志，所以抽屉里显示「还没有日志」是正常的。要验证日志就用 `chatter` 或 `flood` 节点，验证产物用 `artifacts` 节点，验证失败路径用 `fail` 节点或 `outcome`（`succeed=false`）。
- 节点包的依赖要从网络安装。`sfly-stub` 没有第三方依赖，所以离线也能跑；换成别的包时，离线环境下会以 `env_error` 失败，这不是界面的问题。
- 时间是真实时间，不是手动时钟。`sleep` 节点会真的等，等待时间别设太长。
