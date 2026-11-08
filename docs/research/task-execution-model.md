# 执行器的进程模型：「一个任务一个进程」的开销与替代方式

调研日期：2026 年 11 月。背景是 issue #76：每个包节点的每次执行（每个任务、每次重试）都由 Agent 新启动一个执行器进程 `python -I -u -m sfly.runner`（`agent/src/executor.rs`、`sdk/python/src/sfly/runner.py`，ARCHITECTURE §5.4），一条链上有大量短节点或依赖很重的节点时，启动和导入会不会成为瓶颈，要不要换一种执行方式。

完整测量数据（三轮，含方法、机器、提交号、样本量）在 #76 的评论里：[进程开销与端到端拆分][data]、[原型实测][data-proto]。本文只写结论和关键数值。

## 1. 结论

1. **每个任务仍是一个独立的新进程**。任务之间的隔离写进语义规范，作为对用户的承诺（SEMANTICS §3.5）。常驻进程池和进程内执行不再考虑。
2. **已做：延迟导入标准库**（#142）。执行器启动时不再导入只在部分情况下用到的标准库，空节点每节点 45 → 37 ms。sfly-std 节点没有变化，因为 httpx 本来就会导入这些模块。
3. **不做**：
   - Agent 安装节点包时生成字节码（§3.3）；
   - 执行器写完结果就上报、不等进程退出，或用 `os._exit` 跳过解释器退出（§3.4）；
   - 预启动备用进程（§2.3）。
4. **方向定为 forkserver**：每个节点包版本一个预导入好的模板进程，每个任务从它 fork 一个新进程。
   - 约定的门槛：延迟导入合入后，sfly-std 短节点的「解释器启动 + 导入」**占每节点端到端耗时一半以上**，并且**不低于 50 ms**。实际是约 55%、58 ms，越过了门槛。
   - 原型实测（§2.3）：sfly-std 短节点每节点 106 → 47 ms，重依赖节点 286 → 27 ms，4 个重依赖任务同时运行的内存 144 → 52 MB。
   - 设计还没定，要回答的问题见 §4，另开讨论产出 ADR 和 spec issue。

这件事要解决的是**链路延迟**：编排是单链（ADR 0001），一条链上的节点依次执行，每个节点的启动和导入开销会串行叠加，槽位再多也帮不上。内存和吞吐是次要目标。

## 2. 测量结果

本机：i5-1135G7（4 核 8 线程），7.2 GiB 内存，Python 3.13.18。数值是中位数，只用于相对比较。

### 2.1 端到端：一个节点的时间花在哪里

测法：打包后的控制面 + PostgreSQL + release Agent，跑 30 个节点的单链，临时打点拆出各段。节点模块已有字节码。

| 节点 | 每节点总耗时 | 解释器启动 + 导入 sfly | 导入节点模块 | 执行 | 进程退出 | 控制面派发 | Agent 自身 | 30 节点整条链 |
|---|---|---|---|---|---|---|---|---|
| 空节点 | **46** | 31 | 0 | 0 | 6.5 | 7 | 1 | 1.4 s |
| sfly-std `http_request` | **106** | 31 | 27 | 20 | 16 | 11 | 1 | 3.3 s |
| pandas 节点 | **318** | 31 | 218 | 0 | 52 | 17 | 1 | 9.6 s |

- **时间主要花在进程本身**：启动、导入和退出合计占每节点耗时的 70–94%。控制面派发 7–17 ms，Agent 自身（写 `task.json`、建 FIFO、启动进程、回报）约 1 ms。
- `http_request` 的「执行」20 ms 里大半也是导入：第一次创建 `httpx.Client` 时才懒加载 httpcore、anyio、certifi 等，并加载 CA 证书包。
- 导入 sfly 的约 23 ms 几乎都花在它引用的标准库上：json/re/enum 约 8 ms、inspect 约 6 ms、traceback、urllib.parse、typing 各约 3.7 ms、pathlib 约 3 ms。

### 2.2 执行器单独测：几种执行方式的对比

测法：不经过控制面和 Agent，直接按 Agent 的方式启动执行器，同时写了 forkserver 和常驻进程的原型做对照（ms）。

| 方式 | 空节点 | pandas 节点 |
|---|---|---|
| 现状：每个任务启动新解释器 | 37 | 306 |
| 现状，节点包刚安装、还没有字节码 | – | 1145 |
| forkserver，只预导入 sfly | 2.4 | 230 |
| forkserver，预导入 sfly 和节点模块 | – | 3.5 |
| 常驻进程（第二次起） | 0.17 | 0.21 |

- 只预导入 sfly 的 forkserver，每个节点只省约 30 ms（再加上退出的那段）。要让依赖重的节点明显变快，必须连节点模块一起预导入。
- 内存：4 个 pandas 任务同时运行，独立进程合计 PSS 185 MB。forkserver 在 fork 前 `gc.collect(); gc.freeze()` 后是 72 MB；不 freeze 的话，子进程一跑 GC 写时复制就失效，变成 137 MB。常驻进程不能共享内存，仍是 185 MB。

### 2.3 原型实测：预启动备用进程与 forkserver

测法：在 Agent 里临时实现两种做法（原型不进仓库），用 `pnpm perf` 第 10 项和两个附加场景，在 main @ 9a8e59c（已含延迟导入）上和现状比较。

- **预启动备用进程**：每个任务开始时，为同一个节点包另外启动一个新进程，先导入好 sfly 和节点模块，下一个任务直接交给它，用完退出。
- **forkserver**：每个节点包版本一个单线程模板进程，预导入整个包，`gc.freeze()` 后每个任务 fork 一个子进程。子进程 `setsid`，按现在的方式正常退出（执行 atexit）。

30 节点单链（每节点中位数 / 整条链）与资源：

| 场景 | 现状 | 预启动备用进程 | forkserver |
|---|---|---|---|
| 空节点 | 37 ms / 1.15 s | 23–28 ms / 0.77 s | 27 ms / 0.84 s |
| sfly-std `http_request` | 106 ms / 3.3 s | 69–77 ms / 2.3 s | **47 ms / 1.45 s** |
| 重依赖节点 | 286 ms / 8.6 s | 快慢交替 / 5.4–6.1 s | **27 ms / 0.87 s** |
| 一条链上交替使用两个节点包（重依赖 / std） | 6.1 s | 6.4–7.2 s（换包就丢弃旧的备用进程） | **1.1 s** |
| 4 条重依赖链同时运行，每条链 | 14.9 s | 12.7 s | **1.6 s** |
| 4 个重依赖任务同时运行，合计 PSS | 144 MB | 278 MB | **52 MB** |
| 节点包第一次运行 | – | 和现状相同 | 第一个任务要等模板导入完整个包，最多多约 200 ms |
| 原型规模 | – | 约 220 行 | 约 350 行（难做的部分没做，见 §4） |

- **预启动备用进程不做**：它只是把导入提前到上一个节点运行时做，CPU 工作量没少。
  - 导入比一个节点周期长时，备用进程常常赶不上下一个任务；
  - 多条链并发时 CPU 本来就满，只快 0–15%；
  - 链上交替换包时比现状慢 3–18%；
  - 内存几乎翻倍。
- **forkserver 在所有场景下都最快，内存也最省**，因为它确实少做了导入。剩下的约 19 ms 里有 16 ms 是子进程退出：解释器要清理从模板继承来的整个堆，触发写时复制，而且退出耗时随模板大小增长。

## 3. 各种做法的对比

### 3.1 成熟系统的五类做法

| 做法 | 代表 | 隔离 | 超时 / 取消 | 和 sfly 的契合度 |
|---|---|---|---|---|
| A. 每个任务启动新解释器（现状） | [Prefect 3 process worker][prefect3]（新会话 + killpg，SIGTERM → 30 s → SIGKILL）、RQ SpawnWorker、Airflow 3 在 macOS 上 | 最干净 | 杀进程组，可靠 | 已经在用；慢在启动和导入 |
| B. 每个任务从预热好的进程 fork | [Airflow 3][airflow-sup] 默认（先导入 task_runner、`gc.freeze()` 再 fork）、RQ 默认 Worker | 每个任务一个新进程，但继承父进程的线程、锁和连接 | 杀进程组，可靠 | 父进程必须单线程。[Airflow #71707][airflow-71707]：fork 时父进程的线程正持有 OpenSSL 锁，任务第一次发 TLS 请求就永久挂住。Agent 是多线程的 tokio 进程，自己不能 fork，所以这条路对 sfly 来说就是 C |
| C. forkserver / Zygote | Python 3.14 起 POSIX 的[默认启动方式][py-mp]、[Dagster multiprocess][dagster-mp]（`forkserver` + `preload_modules`，明确不支持 fork）、[PySpark daemon][spark-daemon]、Android Zygote | 和 B 一样，但模板进程是专门起的、干净的单线程进程 | 子进程不是 Agent 的直接子进程，pid 和退出状态要由模板进程回报 | **最贴近现有语义** |
| D. 常驻进程池 | [Celery prefork][celery-request]、Huey、Dramatiq、Gunicorn、Ray、Bazel persistent workers | 全局状态、内存泄漏、后台线程跨任务残留，只能靠 max-tasks / max-memory 定期换进程 | Celery 硬超时是 SIGTERM，0.1 s 后 SIGKILL，**再补一个进程**；`revoke(terminate)` 可能误杀已经在跑下一个任务的进程 | 违背任务之间互不影响 |
| E. 进程内线程 / 子解释器 | Celery solo/threads、Temporal 线程模式 activity、3.14 的 `InterpreterPoolExecutor` | 最弱 | 线程注入异常打断不了卡在 C 代码里的调用；[子解释器][py-interp]无法销毁正在运行的解释器 | 不可行：numpy 不支持子解释器 |

D 和 E 被隔离承诺排除（SEMANTICS §3.5）。测试平台最怕前一个用例污染后一个用例，取消和超时也要靠杀进程组兜底。剩下 A（现状）和 C（forkserver）。

### 3.2 不改进程模型的优化

| 优化 | 能省多少 | 决定 |
|---|---|---|
| 延迟导入标准库 | 空节点每节点 45 → 37 ms；sfly-std 和重依赖节点不变（#142） | 已做 |
| 安装时生成字节码 | 首次运行变快，但编译更贵 | 不做（§3.3） |
| 写完结果就上报 / `os._exit` | 每个节点 6–52 ms（退出的那段） | 不做（§3.4） |

### 3.3 为什么不在安装时生成字节码

节点包刚安装、还没有 `.pyc` 时，第一次运行要多付编译时间（pandas 节点从 0.3 s 变成 1.1 s）。但 Agent 是在**第一个任务到达时**才安装节点包的，编译时间也算在这个任务上，而且 `uv pip install --compile-bytecode` 会编译包里的所有文件，不只是实际导入的：

| 节点包 | 安装时多花 | 首次运行省下 | 净效果 |
|---|---|---|---|
| pandas | +1.8 s（编译 1890 个文件） | 0.8 s | 慢约 1 s |
| sfly-std（httpx、psutil） | +133 ms | 约 98 ms | 基本持平 |

现在的做法是第一次导入时由 Python 只编译实际用到的模块，并写回共享 venv，之后的任务都用缓存。只有安装能提前、不阻塞第一个任务，或者 site-packages 不可写时，预编译才划算。

### 3.4 为什么不提前上报结果

执行器写完 `output.json` 之后还要退出解释器：空节点 6.5 ms，`http_request` 16 ms，pandas 52 ms。有两种办法能省掉这段：Agent 看到结果就上报、进程留在后台慢慢退出；或者执行器用 `os._exit` 直接跳过退出流程。两种都不做：

- 节点注册的 atexit 处理和非守护线程，可能还在运行时下一个任务就开始了；用 `os._exit` 的话，它们干脆不会执行；
- 退出阶段输出的日志会排在结果之后；
- 槽位会被还没退出的进程多占一会儿；
- 违反隔离承诺里「任务结束 = 执行器进程已经退出」这一条（SEMANTICS §3.5）。

## 4. forkserver 要在设计里回答的问题

原型只做了每个任务热路径上的部分，下面这些都省略了，要在设计讨论里逐个定下来，产出 ADR 和 spec issue：

1. **Agent 不再是执行器的父进程**：
   - 子进程的 pid 和退出状态要由模板进程转告。原型的做法是：子进程 `setsid`，模板回报 pid，Agent 照旧按进程组终止；模板 `waitpid` 后回报退出状态。Spark、Zygote 也都是这么做的。
   - Agent 退出时要能终止 fork 出的子进程，不能重新出现 #113 那样的孤儿执行器。
   - 每个任务的 stdout/stderr 怎么接到 Agent：原型用的是两个命名管道，也可以用 SCM_RIGHTS 传 fd。
2. **模板的生命周期**：
   - 模板进程崩溃后要重建。
   - 共享 venv 就地切换版本（ADR 0002）后，模板里已经导入的模块就过期了。安装本来就和启动新任务互斥，在安装时重建模板正好挂在这个点上。类似的做法：Spark 按解释器加环境变量分组，Ray 按 runtime_env 哈希，Bazel 按 WorkerKey。
   - 模板数量要有上限，并按最近使用淘汰。
3. **按什么分组**：
   - 按节点包版本建模板（原型的做法），同一个包里的轻节点要替重模块买单：首个任务多等约 200 ms，每次退出多约 11 ms，因为退出耗时随模板大小增长。
   - 按节点模块建模板可以避免这一点，但模板数量更多。
   - 还要定是否预导入节点函数里才懒加载的依赖，例如 `http_request` 第一次创建 `httpx.Client` 时还要约 20 ms。
4. **和现状的行为差异**（关系到 SEMANTICS §3.5 的隔离承诺怎么表述）：
   - 节点模块在任务开始前就导入了：导入时看到的工作目录是 Agent 的，也没有 `SFLY_*` 环境变量；导入阶段的输出不属于任何任务。
   - 所有任务共用模板的 `PYTHONHASHSEED`，各任务之间字符串哈希相同，集合和字典的迭代顺序也相同；现状下每个进程各不相同。`random` 会在 fork 后重新播种，没有问题。
   - 节点包导入时可能起线程、开连接、读配置，这些都会被 fork 出的所有任务继承，模板也必须保持单线程。所以打算只给**声明了可以预导入**的节点包建模板，sfly-std 先声明；不满足条件时回退到现状。
5. **两套执行方式**：Windows Agent（路线图 P4）没有 fork，本地调试 `sfly run`、`sfly.testing` 也是每个节点启动新解释器，现在的方式必须保留，并作为回退路径。
6. **命名**：要在 GLOSSARY 里给模板进程定个名字，并和「执行器」区分开。

[data]: https://github.com/x7yue/sfly/issues/76#issuecomment-6718115856
[data-proto]: https://github.com/x7yue/sfly/issues/76#issuecomment-6720926551
[prefect3]: https://github.com/PrefectHQ/prefect/blob/3.9.2/src/prefect/workers/process.py
[airflow-sup]: https://github.com/apache/airflow/blob/3.4.0/task-sdk/src/airflow/sdk/execution_time/supervisor.py
[airflow-71707]: https://github.com/apache/airflow/issues/71707
[py-mp]: https://docs.python.org/3.14/library/multiprocessing.html#contexts-and-start-methods
[py-interp]: https://docs.python.org/3.14/library/concurrent.interpreters.html
[dagster-mp]: https://github.com/dagster-io/dagster/blob/1.13.29/python_modules/dagster/dagster/_core/executor/multiprocess.py
[spark-daemon]: https://github.com/apache/spark/blob/v4.3.0/python/pyspark/daemon.py
[celery-request]: https://github.com/celery/celery/blob/v5.7.0/celery/worker/request.py
