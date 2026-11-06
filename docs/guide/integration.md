# 联调

联调把开发中的节点包以开发版本 `<包名>@dev` 装到本机的 sfly Agent 上，在真实场景里运行：验证节点和被测系统、和上下游节点的配合。不需要发布，改了代码马上能在场景里试。

需要本机有一个连上控制面的 Agent：按 [安装 Agent](install-agent.md) 的「开发机」一节用 `--dev` 安装，它在 [Agent 管理](/agents) 页面里显示为在线。

## 加载开发版本

在项目目录里运行：

```sh
uv run sfly dev
```

`sfly dev` 通过本机 Agent 的本地 socket（默认 `~/.sfly/work/agent.sock`；`agent.env` 里改了 `SFLY_WORK_DIR` 或 `SFLY_DEV_SOCKET` 时按同样的配置找）让 Agent 以可编辑方式安装项目的源码，注册为 `<包名>@dev`。Agent 管理页面里这个 Agent 的已安装节点包会列出它。

## 在场景里运行

1. 在 [场景编排](/orchestrations) 里新建或打开一个场景，把节点包里的节点加到链上。
2. 节点的版本选 `dev（开发版本）`，执行的 Agent 选本机 Agent（`dev-<用户名>-<主机名>`）。开发版本只在加载了它的 Agent 上有。
3. 保存并运行，在运行视图里看日志、指标和产物。

## 改代码之后

- 只改了函数体：直接再运行场景，下一个任务就用新代码。
- 改了节点的参数、输出、指标声明、依赖，或者增删了节点：重新运行 `uv run sfly dev`，场景里的参数表单和图表才会更新。

联调通过后 [发布](publish.md)。场景要换成发布的版本：开发版本只在本机 Agent 上有，别人的 Agent 上没有。
