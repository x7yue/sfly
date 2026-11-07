"""sfly-std：标准节点包。

每个标准节点是本包里的一个模块（例如 `shell.py`），`sfly build` 导入全部子模块收集 `@node`，
不需要在这里登记。下划线开头的模块是节点之间共用的工具，不声明节点：

- `_params.py`：多个节点共用的参数校验（正则、端口）；
- `_process.py`：涉及进程的节点共用的工具（找进程、判断存活、启动命令的 cwd 与 env、读退出码）；
- `_supervise.py`：`start_process` 的看护进程（只用标准库，作为脚本运行）；
- `_waiting.py`：等待与重试的轮询（`wait`、`poll`）；
- `_sampling.py`：持续运行的节点的 `interval`、`duration` 校验与速率计算；
- `_logfile.py`：像 `tail -F` 一样读日志文件；
- `_assertions.py`：`assert` 与 `http_request` 共用的断言格式。

新增一个节点：

1. 新建 `src/sfly_std/<节点>.py`，用 `@node(title="中文标题")` 声明；参数默认值不要用可变对象
   （用 `Sequence[int] = (0,)` 这类），能复用上面的共用模块就复用；
2. 新建 `tests/test_<节点>.py`，用 `sfly.testing.run_node` 在真实的执行器进程里测试；
3. 在开发文档「标准节点」页（docs/guide/standard-nodes.md）加一节「## `<节点名>`：<标题>」，
   参数表、输出表、指标表与节点的元信息一致（`tests/test_package.py` 逐项比对）；
4. 只有引入新的第三方库时才改 `pyproject.toml` 的 dependencies（只写宽松下限，之后 `uv lock`）；
   用到新版 SDK 才有的接口时，把 `[tool.sfly] requires-sdk` 调到包含它的第一个平台版本。
"""
