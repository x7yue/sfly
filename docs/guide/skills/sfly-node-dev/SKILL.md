---
name: sfly-node-dev
description: 开发 sfly 节点包：新增或修改 `@node` 节点、本地调试、在本机 Agent 上联调、构建与发布节点包。
---

# sfly 节点开发

本项目是一个 sfly 节点包：用 `@node` 声明的 Python 函数，发布到控制面后由 sfly Agent 在测试机的共享 venv 里执行。SDK 接口见 [reference.md](reference.md)；命令参数以 `uv run sfly <命令> --help` 为准。

## 步骤

1. **写节点**：在 `src/<模块>/` 里增删 `@node` 函数，遵守下面的「规则」。
   完成：每个改动的节点都有对应的单元测试（`sfly.testing.run_node`），成功路径和失败路径各至少一个。
2. **检查**：`uv run ruff format`、`uv run ruff check`、`uv run pytest`。
   完成：三条命令全部通过。
3. **本地调试**：对每个改动的节点运行 `uv run sfly run <节点> --params '<JSON>'`，参数尽量接近真实值。
   完成：输出、日志、指标、产物都符合预期；失败路径（错误参数、节点抛出异常、Ctrl-C 取消）各至少跑过一次。
4. **联调**：需要连真实被测系统，或要验证和上下游节点的配合时做这一步。`uv run sfly dev` 把本项目以 `<包名>@dev` 装到本机 Agent，再请用户在场景里选这个版本和本机 Agent 运行。本机还没有 Agent 时，请用户按控制面开发文档里的「安装 Agent」加 `--dev` 安装（名称默认 `dev-<用户名>-<主机名>`），令牌向用户索取。改了节点的参数、输出、指标声明、依赖或增删节点后重新运行 `sfly dev`；只改函数体时下一个任务直接用新代码。
   完成：用户确认运行结果符合预期。
5. **发布**：递增 `[project].version`，把版本号和改动摘要交给用户确认；用户确认后运行 `uv run sfly publish`（先构建再上传）。
   完成：publish 输出「已发布 <包名>@<版本>」。已发布的 `包名@版本` 不能覆盖，冲突时改版本号再发。

## 规则

### 输入与输出
- 首个参数是 `ctx: Context`，其余参数都是输入，每个都写类型注解：输入的 schema 由注解生成，画布据此渲染参数表单，派发前按它校验参数。可用类型见 reference.md「输入」；可选输入给能 JSON 序列化的默认值。
- 输出用 TypedDict 返回类型声明（或 `@node(outputs=...)`）。返回值是能 JSON 序列化的 dict，不超过 1 MB；大块数据存成产物，输出里放产物引用。
- 失败就抛异常，消息里写清原因和相关参数值；只有成功才返回。

### 日志、进度、指标、产物
- 信息一律通过 `ctx` 输出：`ctx.log` 带级别进入运行视图；耗时操作用 `ctx.progress` 上报进度。
- 指标先在 `@node(metrics=...)` 里声明，再用 `ctx.metric` 上报（未声明的会被丢弃）。`gauge` 是瞬时值，`counter` 是累计值；用 `primary_metric` 指出最能代表运行状况的那个。按对象（进程、连接、网卡……）分别统计时在 `Metric(labels=[...])` 声明标签键、上报时带 `labels`；带标签的指标只能画在 `line` / `area` 图表里，也不能当主指标，需要时另报一个不带标签的合计指标。
- 文件用 `ctx.artifacts.save` / `path` 保存，输出里放返回的产物引用；下游节点用 `ctx.artifacts.download(引用, 本地路径)` 下载，不要自己写 `urlopen`。

### 取消与清理
- 取消或超时时，节点里会抛出 `sfly.Cancelled`（`BaseException` 的子类）。捕获异常时写 `except Exception` 或更具体的类型，让 `Cancelled` 继续往外传；清理代码放在 `finally` / `with` 里，宽限期 10 秒内要做完。后台线程轮询 `ctx.cancelled()`。
- 节点结束后还要存活的资源（启动的进程、造的测试数据）：由创建它的节点输出句柄，清理写成另一个节点，并提醒用户在场景里把它设为 always 节点。

### 状态与依赖
- 状态只放在函数的局部变量里：每个任务是一个新进程，同一节点的多个任务可能并发。临时文件用 `tempfile`；路径从参数或 `ctx` 取得。
- 依赖写进 `[project].dependencies`，只写宽松的下限（如 `requests>=2.28`）：Agent 上所有节点包共用一个 venv，钉死版本最容易和别的节点包冲突。依赖必须能从 PyPI 镜像安装。`sfly` 只放在 dev 依赖组里，因为 Agent 自带 SDK 运行时。
