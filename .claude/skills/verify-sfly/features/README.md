# sfly 验证地图

这个目录记录如何验证 sfly 面向用户的行为，需要持续维护。操作应用之前先读这个索引，再按对应功能文件里的步骤操作。

## 基线前提

- `$V/up.sh` 启动的环境，`$V/doctor.sh` 全部 ok（`V=.claude/skills/verify-sfly/scripts`）。
- `source ~/.local/state/sfly-verify/current/state.env`，再设 `S="--session $BROWSER_SESSION"`。
- 已运行 `$V/publish-stub.sh`，`sfly-stub@0.1.0` 已发布，`verify-agent` 在线、有 4 个槽位。
- 浏览器视口是 1440×900，昵称已填（首次打开会弹「欢迎使用 sfly」）。
- 只操作这次验证启动的环境。

## 操作约定

- 每个步骤都从基线状态开始，除非文件里另有说明。
- 用 ARIA 角色和中文可访问名称定位，例如 `agent-browser $S find role button click --name "新建场景"`。拿不准时先 `snapshot -i -c` 取 `@ref`。
- 页面变化后旧的 `@ref` 就失效了，要重新 `snapshot`。
- 写数据一律走用户路径（页面操作、`sfly publish`）。`curl $HTTP_URL/api/...` 只用来读，作为第二视角。

## 证据与跳过的报告

- 截图存到 `$RUN/evidence/<功能ID>-<序号>-<步骤>.png`，操作之前和操作之后各拍一张。
- 写操作要用 API 或另一个页面再读一次，确认结果，结果存成 `$RUN/evidence/<功能ID>-*.json`。
- 每份证据都写明用的是哪个功能 ID、走的哪个入口。
- 入口走不通时，报告尝试过的命令和不满足的前提。不要拿另一个入口的结果冒充这个入口已经验证过。

## 功能

- [发布节点包](./publish-package.md)：`sfly publish` 发布，节点包管理页的列表与详情，以及不能重复发布同一版本。
- [编排场景](./edit-scenario.md)：新建场景、添加节点、检查器填参数、默认 Agent、保存为新版本。
- [运行与监控](./run-and-monitor.md)：运行抽屉触发运行，实时摘要，运行详情页的日志和输入输出，运行记录列表。
- [Agent 管理](./agents.md)：在线状态、槽位、版本、已安装的节点包。
- [开发文档](./docs.md)：文档页渲染、控制面地址和版本的替换、`/llms.txt`。
