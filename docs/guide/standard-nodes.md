# 标准节点

标准节点包 `sfly-std` 由平台维护，提供 Shell 命令这类与业务无关的**标准节点**，不用每个团队自己再写一遍。它就是一个普通的节点包：在 Agent 上执行，场景锁定它的版本，可以用 `sfly run` 和 `sfly.testing` 调试。

`sfly-std` 有自己的版本号，不随控制面发布，也不会自动出现在控制面上：部署者从 Release 下载后上传一次，之后有新版本时再上传。业务相关的节点仍然由你自己开发（见 [开发节点](sdk-reference.md)）。

## 上传 sfly-std

在本仓库的 GitHub Release 里找到 tag 为 `std-vX.Y.Z` 的版本，下载附件 `sfly-std-X.Y.Z.sflypkg` 和 `SHA256SUMS`。在下载目录里校验并上传到控制面：

```sh
cd ~/Downloads
sha256sum -c SHA256SUMS --ignore-missing
curl -fsS -H 'content-type: application/octet-stream' --data-binary @sfly-std-0.1.0.sflypkg {{SFLY_URL}}/packages
```

- 上传成功时返回节点包的版本信息（JSON）；装了 sfly 命令行时也可以用 `sfly publish sfly-std-0.1.0.sflypkg`。
- 上传后 `sfly-std` 出现在 [节点包管理](/packages) 页面，它的节点出现在画布的节点选择里。Agent 第一次执行时从控制面安装它，依赖（`psutil`、`httpx`）从 PyPI 镜像安装。
- Release 说明写明了需要的**最低 Agent 版本**。Agent 版本更旧时任务以 `env_error` 失败并提示升级（见 [需要的 SDK 版本](publish.md#需要的-sdk-版本)）；Agent 跟随控制面的版本，升级控制面即可。
- 已上传的版本不能覆盖。升级时上传新版本，再在场景里把 `sfly-std` 换成新版本；旧场景不受影响。

## 安全说明

`shell` 等节点让任何能编辑场景的人在 Agent 上以 Agent 的用户身份执行任意命令。这没有扩大攻击面：控制面的发布接口本来就没有认证，任何人都能发布执行任意代码的节点包。在平台有认证和权限控制之前：

- 只让可信的网络访问控制面；
- 用权限受限的专用用户运行 Agent，不要用 root；
- 不要把密钥直接写进节点参数，参数和日志在运行页面上对所有人可见。

## 通用约定

- 节点名是英文标识符，标题是中文；下文表格里的参数名和输出名就是节点表单与引用上游输出时用的名字。
- 运行时间由节点的超时（timeout，默认 1 小时）限制；超时和取消一样终止节点的整棵进程树。
- 运行时的输出实时转为任务日志。节点输出不超过 1 MB，大内容保存为产物。
- 失败时错误信息写明原因和关键参数，在运行页面的节点详情里查看。

## `shell`：Shell 命令

用解释器执行一段命令：`<shell> -c <command>`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `command` | 必填 | 要执行的命令 |
| `shell` | `/bin/sh` | 解释器：`/bin/bash`、`python3` 等任何接受 `-c <命令>` 的程序 |
| `env` | 无 | 追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上 |
| `cwd` | 任务工作目录 | 工作目录，必须已经存在 |
| `ok_exit_codes` | `[0]` | 算作成功的退出码 |

| 输出 | 说明 |
|---|---|
| `exit_code` | 退出码；命令被信号终止时为 128 + 信号值（与 shell 的 `$?` 相同） |
| `stdout` | 标准输出的最后 64 KiB |

- 标准输出和标准错误实时转为任务日志（来源分别是 stdout 和 stderr）。
- 退出码不在 `ok_exit_codes` 里时节点失败，错误信息是退出码、命令和标准错误的末尾（约 4 KiB）。解释器或工作目录不存在时也失败，错误信息写明是哪一个。
- 取消或超时时，命令和它启动的全部子进程都被终止：先发 SIGTERM，宽限期过后强制杀掉。自己调用 `setsid` 脱离进程组的进程不在其中。
- 命令退出时还在运行的后台进程（例如 `server &`）不会被终止，但它们之后的输出不再转为日志。

例：构建后把版本号交给后面的节点。节点 `build` 的参数：

```json
{
  "command": "make dist && cat VERSION",
  "shell": "/bin/bash",
  "cwd": "/srv/app",
  "env": { "BUILD_MODE": "release" }
}
```

后面的节点在参数里引用 `build` 的输出 `stdout` 拿到版本号（含末尾的换行）。允许 `grep` 没有匹配（退出码 1）时，把 `ok_exit_codes` 设为 `[0, 1]`。

## `start_process`：启动后台进程

在新会话里执行 `<shell> -c <command>`，不等它结束：节点立即成功，进程在节点结束后继续运行，用来启动被测系统等常驻进程。之后用 `stop_process` 停止它。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `command` | 必填 | 要执行的命令 |
| `shell` | `/bin/sh` | 解释器，与 `shell` 节点相同 |
| `env` | 无 | 追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上 |
| `cwd` | 任务工作目录 | 工作目录，必须已经存在 |
| `log_file` | `$SFLY_HOME/procs/<运行 ID>/<节点 ID>.log` | 进程的标准输出和标准错误追加写入的文件；相对路径相对于 `cwd`，目录不存在时自动创建 |

| 输出 | 说明 |
|---|---|
| `pid` | 进程号：交给 `stop_process`、`process_monitor` 等节点 |
| `log_file` | 日志文件的绝对路径：交给 `wait_log_line`、`follow_log`、`collect_artifacts` 等节点 |

- 进程在新的会话和进程组里，不属于任务的进程树：节点结束、任务被取消或超时都不会终止它，运行结束后也不会自动停止，**一定要配一个 `stop_process`**（见下一节的例子）。
- 进程的输出不转为任务日志，只写进 `log_file`。默认位置不在任务目录里：任务目录被清理时不受影响，和任务目录按同一个保留期清理（运行还有任务在这个 Agent 上时不动，后台进程还在写日志时不会被删，见 [安装 Agent](install-agent.md)）。同一个节点重试时追加到同一个文件。
- 节点只负责把进程启动起来：命令随后失败退出时节点仍然成功，用 `wait_port`、`wait_log_line` 等节点等它就绪，用 `stop_process` 的 `exit_code` 查看它是否异常退出过。解释器或工作目录不存在时节点失败。
- 进程运行在执行这个节点的 Agent 所在的机器上，后面引用它的节点（`stop_process`、监控节点等）要选同一个 Agent。

例：启动被测服务。节点 `server` 的参数：

```json
{
  "command": "exec ./bin/server --port 8080",
  "cwd": "/srv/app",
  "env": { "LOG_LEVEL": "debug" }
}
```

命令前加 `exec` 让解释器直接换成服务进程，`pid` 就是服务本身的进程号（不加时是解释器的进程号，服务是它的子进程，`stop_process` 同样能把它们一起停掉）。

## `stop_process`：停止后台进程

终止 `pid` 所在的整个进程组：先发 SIGTERM，宽限期过后还没退出的发 SIGKILL。进程已经不在时直接成功。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `pid` | 无 | 要停止的进程号，通常引用 `start_process` 的输出 `pid`；为空时什么也不做、直接成功 |
| `grace` | `10` | 从 SIGTERM 到 SIGKILL 的宽限期（秒） |

| 输出 | 说明 |
|---|---|
| `was_running` | 开始停止时进程是否还在运行 |
| `exit_code` | 进程的退出码：被信号终止时为 128 + 信号值（SIGTERM 为 143，被 SIGKILL 强制杀掉为 137）；拿不到时为 null |

- 终止的是整个进程组：`start_process` 启动的命令和它的子进程（包括命令自己已经退出、留在后台的进程）都会被终止。自己调用 `setsid` 脱离进程组的进程不在其中。
- `exit_code`：进程由同一次运行里、同一个 Agent 上的 `start_process` 启动时能拿到。`was_running` 为 false、`exit_code` 不是 0 时，说明进程在停止之前就异常退出了。
- 宽限期加 SIGKILL 后进程仍没有退出（例如卡在不可中断的磁盘读写里）时节点失败。

**放在 always 节点里清理**：把 `stop_process` 设为 always 节点，前面的节点失败或运行被取消时它仍然执行，被测进程不会留在机器上。`start_process` 本身失败时，引用的 `pid` 解析为空，`stop_process` 直接成功。例：场景依次是 `server`（`start_process`）、等待就绪、压测，最后是 always 节点 `stop_server`（`stop_process`），参数里的 `pid` 引用节点 `server` 的输出 `pid`，宽限期设为 30 秒：

```json
{
  "grace": 30
}
```

`stop_server` 要和 `server` 选同一个 Agent。压测中服务意外退出时，`stop_server` 的输出是 `was_running` 为 false、`exit_code` 为服务的退出码。
