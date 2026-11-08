# 本地调试

本地调试在开发机上直接执行节点，不经过控制面和 sfly Agent，几秒钟就能验证节点逻辑。单元测试（`sfly.testing`）和 `sfly run` 都用和 Agent 相同的执行器：参数校验、输出限制、日志、指标、产物和取消的行为都和在 Agent 上一致，本地通过的节点在 Agent 上也能跑。

下面的命令都在项目目录（`sfly init` 创建的目录）里运行。

## 检查与单元测试

```sh
uv run ruff format
uv run ruff check
uv run pytest
```

单元测试用 `sfly.testing.run_node` 执行节点，拿到输出、日志、进度、指标和产物，也能模拟取消，写法见 [开发节点（SDK 参考）](sdk-reference.md) 的「sfly.testing」一节和示例项目里的 `tests/test_example.py`。每个节点至少测一条成功路径和一条失败路径。

## `sfly run`

用真实的参数执行一个节点：

```sh
uv run sfly run countdown --params '{"name": "世界"}'
```

- 第一个参数是节点名（`@node` 的 `name`，默认是函数名）；`--params` 是输入，一个 JSON 对象，按类型注解校验。
- 日志实时打印到标准错误（时间、级别、来源、消息）。
- 结束后在标准输出打印输出值（`输出：` 后面的 JSON）、指标汇总表（每个指标的次数、最后值、最小值、最大值）和运行目录。
- 每次运行一个新目录 `.sfly/runs/<时间>-<节点>/`：产物在 `artifacts/` 下，还有标准输出、标准错误的副本（`stdout.log`、`stderr.log`）。日志、进度和指标经命名管道 `events.fifo` 实时读取，不另存文件。`.sfly/` 已被 git 忽略。

失败路径也要跑一次。节点抛出异常时打印 `节点失败：` 和 traceback，退出码 1：

```sh
uv run sfly run countdown --params '{"name": "世界", "steps": 0}'
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 节点失败（抛出异常、输出不合法） |
| 2 | 参数不合法或找不到节点，节点没有执行 |
| 130 | 按 Ctrl-C 取消 |

## 取消

运行中按 Ctrl-C，按平台的取消流程取消：节点里抛出 `sfly.Cancelled`，`finally` 里的清理代码照常执行，宽限期（默认 10 秒，`--grace` 修改）过后强制杀掉进程树；再按一次 Ctrl-C 立即杀掉。节点结束后结果已经确定，打印结果期间的 Ctrl-C 会被忽略，退出码按结果给出。用一个跑得久的参数验证清理代码：

```sh
uv run sfly run countdown --params '{"name": "世界", "steps": 100, "interval": 1}'
```

看到 `开始倒计时` 后按 Ctrl-C：日志里接着出现 `倒计时结束`（写在示例节点的 `finally` 里），最后打印 `已取消：`，退出码 130。

本地调试通过后，到本机 Agent 上 [联调](integration.md)。
