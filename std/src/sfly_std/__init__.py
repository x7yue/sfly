"""sfly-std：节点代码里可以直接调用的辅助函数，加三个薄节点（ADR 0030）。

辅助函数是主体，从下面这些模块导入（每个函数都有文档字符串、类型标注和单测）：

- `sfly_std.commands`：`run_command` 执行一段命令，输出实时转成任务日志；
- `sfly_std.processes`：`start_background_process`、`stop_background_process` 起停跨节点存活的
  后台进程，`find_processes`、`ProcessFinder` 按进程号、进程名或命令行找进程；
- `sfly_std.resources`：`monitor_system`、`monitor_processes` 采样整机或一组进程的资源并上报指标，
  进程重启后按名字重新找到它（`refind`）；
- `sfly_std.logs`：`LogFile`、`follow_log_file`、`wait_for_log_line` 像 `tail -F` 一样读日志，
  处理轮转和截断；
- `sfly_std.waiting`：`poll_until`、`wait_for_port`、`wait_for_file` 等条件成立、判断文件写完；
- `sfly_std.agent_files`：`pull_files_from_agent`、`watch_agent_files` 经 Agent 能力从另一台机器
  拉文件。

业务节点导入它们自己组合：函数能传参数、传回调，节点的行为由自己的代码决定。用法和一个完整的
示例见开发文档「标准节点」页（docs/guide/standard-nodes.md）。写法上的约定：结果是 frozen 数据类
（不返回裸的数字）；路径参数可以是 `str` 或 `os.PathLike`，返回的路径是 `pathlib.Path`；时间都以秒
为单位；同一个节点里可以多次调用，默认的产物名、日志文件名每次不同。

三个节点是这些函数上的薄封装：`shell`、`start_process`、`stop_process`。`sfly build` 导入全部
子模块收集 `@node`，不需要在这里登记。

兼容性承诺：一台 Agent 的共享环境里只有一个 `sfly-std` 版本，所有依赖它的节点包用的是同一份，
所以公开的接口只做向后兼容的改动：

- 上面这些模块里 `__all__` 列出的函数、类、常量，签名只增不减：新增的参数只能是带默认值的
  关键字参数，已有参数的名字、含义和默认值不变；
- 返回值（数据类的字段）只增不减，异常的类型名不变；`*_METRICS`、`*_CHARTS` 这类常量是元组，
  只在末尾增加；
- 要改变已有行为、或不再兼容，就加一个新名字的函数，旧的继续留着；
- 以下划线开头的模块（`_names`、`_params`、`_process`、`_supervise`、`_sampling`、`_pull`）
  和不在 `__all__` 里的名字是内部实现，随时可能改，不要导入；公开模块里本模块定义的
  函数和类，要么在 `__all__` 里，要么以下划线开头（`tests/test_public_api.py` 检查）；
- 承诺的内容就是 `tests/public_api.txt` 里的快照（每个公开名字的参数名、种类、默认值、返回值、
  字段、基类）：`tests/test_public_api.py` 把当前的接口和它比对，改接口必须同时改快照，评审时一眼
  看得见；不兼容的改动（改名、删除、改默认值、改类型）在比对里单独标出，要改就加新名字。

新增一个辅助函数或节点：

1. 辅助函数写在对应的模块里并加进 `__all__`：文档字符串写做什么、参数含义、什么情况下抛出什么
   异常；全部参数和返回值写类型标注；参数默认值不要用可变对象（用 `Sequence[int] = (0,)` 这类）；
   在 `tests/` 里直接调用它测试（`sfly.testing.run_node` 在真实的执行器进程里跑节点；
   辅助函数需要 `Context` 时用 `tests/direct_context.py` 的 `DirectRun`，它把事件、取消标记、
   产物和后台进程目录都指到临时目录，还能读回日志和指标；用户的业务节点没有这个文件，开发文档
   「标准节点」页写了怎么用公开的 `sfly.Context` 构造函数造一个）；
   然后重新生成 `tests/public_api.txt`（`uv run python tests/public_api_snapshot.py --write`）；
2. 节点写成辅助函数上的薄封装：新建 `src/sfly_std/<节点>.py`，用 `@node(title="中文标题")` 声明，
   每个输入和输出写 `Annotated[类型, Doc("…")]`，文档字符串写成节点做什么、副作用、什么情况下失败，
   都是纯文本（画布上不渲染 Markdown，不写反引号）；
3. 在「标准节点」页（docs/guide/standard-nodes.md）加一节，参数表、输出表、指标表与节点的元信息
   一致，参数表和输出表「说明」列的文字与 `Doc` 一字不差（`tests/test_package.py` 逐项比对）；
4. 只有引入新的第三方库时才改 `pyproject.toml` 的 dependencies（只写宽松下限，之后 `uv lock`）；
   用到新版 SDK 才有的接口时，把 `[tool.sfly] requires-sdk` 调到包含它的第一个平台版本；
   用到新的 Agent 能力（`ctx.agent()`）时同样调高 `requires-agent`。
"""
