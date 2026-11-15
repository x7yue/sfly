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

在浏览器里：

1. 在 [场景编排](/orchestrations) 里新建或打开一个场景，把节点包里的节点加到链上。
2. 节点的版本选 `dev（开发版本）`，执行的 Agent 选本机 Agent（`dev-<用户名>-<主机名>`）。开发版本只在加载了它的 Agent 上有。
3. 保存并运行，在运行视图里看日志、指标和产物。

## 用命令行联调

不打开浏览器也能联调：复制场景、改成开发版本、运行并读结果都是命令。AI 编程助手按项目里的 `sfly-platform` skill 自己做完这些，不用你去浏览器里点；你自己也可以照着做。各命令的用法、输出和退出码见 [用命令行操作平台](platform-cli.md)。

1. 复制一份场景作为**联调副本**，名称写成 `<原名>-联调-<昵称>`，改动都在这份副本上，不影响别人在用的原场景；以后联调沿用这一份。昵称按 `--nickname` > 环境变量 `SFLY_NICKNAME` > 系统用户名取值。没有现成的场景可以复制时，用 `sfly scenario create --name <名称> --description <说明> --from <文件>` 新建一个。

   联调副本的场景说明第一行写明用途：「联调 <包名>，由 <昵称> 的 AI 编程助手创建」，搭场景的人在场景列表里看到它，就知道它做什么、能不能删。`scenario copy` 会把原场景的说明一起复制过来，复制后用 `sfly scenario rename <副本> --description …` 改说明：第一行写这句用途，后面接原场景的说明。

   ```text
   uv run sfly scenario copy 回归 --name 回归-联调-小王
   ```

2. 下载副本，在文件的 `document` 里把 `packages` 中这个节点包的版本改成 `"dev"`，把 `default_agent`（以及节点上单独选了的 `agent`）改成本机 Agent，再保存成新的场景版本：

   ```text
   uv run sfly scenario pull 回归-联调-小王 -o 联调.json
   uv run sfly scenario push 联调.json
   ```

3. 运行并等它结束，进度在 stderr，结束后 stdout 是摘要：

   ```text
   uv run sfly run start 回归-联调-小王 --wait
   ```

退出码说明结果：0 运行成功；1 运行失败，摘要里写出失败节点的错误和它最后 50 行日志；2 命令本身出错（参数、预检问题、连不上控制面）；3 运行被取消；124 等待超时，运行仍在继续，用 `sfly run wait <运行>` 接着等，不要重新触发。失败后改完代码再运行同一条命令；运行成功后核对节点输出、日志和指标是否符合预期，联调才算完成。

## 改代码之后

- 只改了函数体：直接再运行场景，下一个任务就用新代码。
- 改了节点的参数、输出、指标声明、依赖，或者增删了节点：重新运行 `uv run sfly dev`，场景里的参数表单和图表才会更新。

联调通过后 [发布](publish.md)。场景要换成发布的版本：开发版本只在本机 Agent 上有，别人的 Agent 上没有。
