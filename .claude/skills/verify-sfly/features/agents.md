# Agent 管理

用户在「Agent 管理」页看每台 Agent 的在线状态、槽位占用、版本、系统和架构、已安装的节点包、被多少场景引用以及最近在线时间。侧边栏的链接上会显示「在线数/总数」。

## Sub-features

- `agt-list`：表格每行是一台 Agent，各列依次是名称、状态、槽位（已用/总数）、版本、`linux/x86_64`、已安装的节点包、引用它的场景数、最近在线。
- `agt-nav-count`：侧边栏「Agent 管理 1/1」。
- `agt-offline`：Agent 断开后状态变成离线，显示离线时间。
- `agt-installed`：执行过某个包的节点后，「已安装」列出现 `<包>@<版本>`。

## How to get to it (user POV)

- 侧边栏 `link "Agent 管理 N/M"`，也就是 `/agents`。
- 编排画布里「默认 Agent」「节点 Agent」下拉框里的选项，例如 `verify-agent · 在线 · 0/4 槽位`。

## Driving it with agent-browser

Preconditions:

- 基线环境，`verify-agent` 在线。

- **列表。** 打开 `$HTTP_URL/agents`，能看到 `heading "Agent 管理"`；`row` 里名称匹配 `verify-agent` 的那一行写着 `在线`、`0/4`、工作区版本（`apps/server/package.json` 的 version）、`linux/x86_64`。截图 `agt-01-list.png`。
- **已安装的节点包。** 按 [运行与监控](./run-and-monitor.md) 跑完一次 `sfly-stub` 节点后刷新页面，这一行出现 `sfly-stub@0.1.0`；再用 `curl -s $HTTP_URL/api/agents` 看 `installed_packages`，两边一致。
- **离线。** 运行 `kill -TERM -- -$AGENT_PGID` 只停掉这套环境的 Agent，几秒内页面上这一行变成离线，侧边栏变成 `0/1`。截图 `agt-02-offline.png`。做完这一步这套环境就没有 Agent 了，之后只能 `down.sh` 再重新 `up.sh`。

## Gotchas

- 版本和控制面不一致的 Agent 不会被派任务。debug 版 Agent 必须和控制面用同一份工作区代码构建；`up.sh` 每次都会重新构建，用 `--no-build` 时要自己确认。
- 离线那一步会让 `doctor.sh` 失败，这是正常的。离线验证放到最后做。
- 槽位默认 4 个，来自 Agent 的默认参数；`up.sh` 没有传 `--slots`。
