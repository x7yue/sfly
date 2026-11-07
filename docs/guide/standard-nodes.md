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

## `assert`：断言

对任意值逐条做断言：数值、文本、JSON 都用同一个节点检查。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `actual` | 必填 | 要检查的值，通常整个值就是一个引用（引用上游节点的输出，保持原类型）；也可以是包含多个引用的对象 |
| `assertions` | 必填 | 断言列表，至少一条；每条是 `{"path": ..., "op": ..., "value": ...}` |

每条断言的写法：

| 键 | 说明 |
|---|---|
| `path` | 取 `actual` 的哪一部分，默认 `$`（整个值）。支持 JSONPath 的常用子集：`$.a.b`、`$.items[0]`、`$.items[-1]`（从末尾数）、`$["带 空格.的键"]`、通配 `$.items[*]` 和 `$.service.*` |
| `op` | 比较方式，见下表 |
| `value` | 期望值；`exists` 可以省略 |

| `op` | 通过的条件 |
|---|---|
| `eq` / `ne` | 等于 / 不等于 `value`。按 JSON 比较：`1` 等于 `1.0`，`true` 不等于 `1`，数组按顺序比较，对象按键比较 |
| `gt` `ge` `lt` `le` | 大于、大于等于、小于、小于等于 `value`（数字）。实际值是数字文本时按数值比较，例如 shell 的 stdout `"42\n"` |
| `contains` | 文本包含 `value` 这段文字；数组含有等于 `value` 的元素；对象含有名为 `value` 的键 |
| `matches` | 文本里有匹配正则表达式 `value` 的部分（Python 语法，多行模式：`^` `$` 匹配每一行的开头和结尾）。要求整段匹配时写成 `\A...\Z` |
| `exists` | 路径存在；`value` 为 `false` 时要求路径不存在 |
| `len_eq` | 文本的字符数、数组的元素数或对象的键数等于 `value` |

| 输出 | 说明 |
|---|---|
| `passed` | 全部通过时为 `true` |

- 有断言不通过时节点失败，错误信息逐条列出不通过的断言：第几条、具体路径、期望和实际值。例如 `第 2 条：$.items[1].status 应 eq "ok"，实际是 "error"`；值太长时只显示开头。
- 路径里有通配时，每个匹配到的值都要满足；一个都没匹配到时不通过（`exists` 为 `false` 时通过）。
- 路径不存在时，除 `exists` 外的断言都不通过（`ne` 也一样），错误信息写明「路径不存在」。
- 断言写错时（路径无法解析、缺少 `value`、`value` 类型不对、正则表达式不合法、有未知的键）节点失败，错误信息写明是第几条、哪里不对，不检查任何断言。
- 断言格式与 `http_request` 的 `expect_json` 相同。

例：节点 `count` 是一个 `shell`，输出某个目录下的文件数。检查它成功执行、文件数至少 3 个，节点 `check` 的参数：

```json
{
  "actual": {
    "exit_code": "<引用 count 的输出 exit_code>",
    "stdout": "<引用 count 的输出 stdout>"
  },
  "assertions": [
    { "path": "$.exit_code", "op": "eq", "value": 0 },
    { "path": "$.stdout", "op": "ge", "value": 3 }
  ]
}
```

两处尖括号在画布里分别填成对 `count` 输出 `exit_code` 和 `stdout` 的整值引用。检查一个 JSON 响应里每一项的状态都是 `ok`（`items` 为空时也不通过）、并且有 `total` 字段时，`actual` 整值引用上游的 JSON 输出，`assertions` 写成：

```json
[
  { "path": "$.items[*].status", "op": "eq", "value": "ok" },
  { "path": "$.total", "op": "exists" }
]
```

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

## `process_monitor`：监控进程

按采样间隔统计一个或多个目标进程（默认连同它们的全部子孙进程）用了多少资源，指标是所有进程的合计；每个进程每次采样的明细写进产物 `processes.csv`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `pid` | 无 | 进程号，或进程号的列表；通常引用 `start_process` 的输出 `pid` |
| `name` | 无 | 进程名（可执行文件名，例如 `nginx`，必须完全一致），或进程名的列表 |
| `match` | 无 | 命令行（各参数以空格连接）的正则表达式，部分匹配即可，或正则的列表 |
| `include_children` | `true` | 是否连同目标的全部子孙进程一起统计 |
| `wait_for_process` | `60` | 开始时最多等多少秒让每个目标都出现 |
| `interval` | `1` | 采样间隔（秒） |
| `duration` | 无 | 监控多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消 |
| `on_exit` | `fail` | 目标进程退出时：`fail` 让节点失败，`succeed` 让节点成功结束 |

| 输出 | 说明 |
|---|---|
| `samples` | 采样了多少次 |
| `processes_csv` | 产物 `processes.csv` 的引用 |

| 指标 | 单位 | 说明 |
|---|---|---|
| `cpu_percent`（主指标） | % | CPU 占用之和，一个核满载为 100 |
| `rss_bytes` | B | 常驻内存之和 |
| `threads` | | 线程数之和 |
| `open_fds` | | 打开的文件描述符数之和 |
| `io_read_bytes_per_s` | B/s | 磁盘读取速率之和 |
| `io_write_bytes_per_s` | B/s | 磁盘写入速率之和 |

| `processes.csv` 的列 | 说明 |
|---|---|
| `time` | 采样时间（UTC，ISO 8601，到毫秒），同一次采样的各行相同 |
| `pid` | 进程号 |
| `ppid` | 父进程号 |
| `name` | 进程名 |
| `cpu_percent` | 这个进程在上一次采样以来的 CPU 占用 |
| `rss_bytes` | 常驻内存（字节） |
| `threads` | 线程数 |
| `open_fds` | 打开的文件描述符数 |
| `io_read_bytes_per_s` | 磁盘读取速率（字节/秒） |
| `io_write_bytes_per_s` | 磁盘写入速率（字节/秒） |
| `cmdline` | 命令行 |

- 目标：`pid`、`name`、`match` 至少给一个，可以同时给多个；每个进程号、进程名、正则各是一个目标，所有目标匹配到的进程合在一起统计，同一个进程只算一次。
- 开始时每个目标都要匹配到进程，最多等 `wait_for_process` 秒，等不到时节点失败，错误信息列出没找到的目标。
- 每次采样都重新查找：按名称或正则匹配的新进程、新的子进程会加进来，退出的进程不再统计。进程列表开始时写一次日志，之后有进程加入或退出时写一次，没有变化时每 60 秒写一次（附每个进程的 CPU、内存、线程数、文件描述符数）。
- **目标退出**：某个目标匹配的进程全部退出时（子孙进程退出不算），按 `on_exit` 失败或成功结束。被监控的进程是同一次运行里 `start_process` 启动的时，错误信息附上它的退出码。想在被测进程退出时正常结束监控，设为 `succeed`。
- `processes.csv` 每采样一次就写入：节点被停止、取消、因目标退出失败时，已采集的明细都在产物里。第一次采样在开始后一个 `interval` 时（CPU 占用要两次读数才能算出来）；某个进程第一次被采样时它的 IO 速率为空。
- 别的用户的进程读不到文件描述符数和 IO（Agent 不是 root 时），`processes.csv` 里这两项为空，不计入合计。
- 按进程分别画曲线暂不支持，需要时下载 `processes.csv`。监控的是执行这个节点的 Agent 所在机器上的进程，引用 `start_process` 的 `pid` 时要选同一个 Agent。

例：压测期间监控被测服务。服务由 `start_process` 节点 `server` 启动，会再启动若干工作进程；在一个子流程里放 `process_monitor`，参数里的 `pid` 引用节点 `server` 的输出 `pid`，压测结束后用停止子流程节点停止这个子流程，服务中途退出时监控失败、暴露问题：

```json
{
  "interval": 2
}
```

按名称和命令行监控机器上已有的几个服务，不统计子进程，最多监控 10 分钟，其中任何一个服务的进程全部退出时提前成功结束：

```json
{
  "name": ["nginx", "redis-server"],
  "match": "java .*-jar /srv/app/app\\.jar",
  "include_children": false,
  "duration": 600,
  "on_exit": "succeed"
}
```

## `http_request`：HTTP 请求

发一个 HTTP 请求，检查状态码和响应 JSON；打开 `until_ok` 时重试直到满足，可以用来等待 HTTP 服务就绪。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `url` | 必填 | 请求地址，`http://` 或 `https://` |
| `method` | `GET` | `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`HEAD`、`OPTIONS` |
| `headers` | 无 | 请求头（对象，值为字符串） |
| `json` | 无 | JSON 请求体（任意 JSON 值），自动加上 `Content-Type: application/json` |
| `body` | 无 | 文本请求体，按 UTF-8 发送；需要时在 `headers` 里写 `Content-Type`。与 `json` 只能填一个 |
| `request_timeout` | `30` | 单次请求最多等多少秒（连接、发送、等响应） |
| `verify_tls` | `true` | 是否校验 HTTPS 证书；被测环境用自签证书时设为 `false` |
| `expect_status` | `"2xx"` | 算作成功的状态码：状态码（例如 `404`）或 `"1xx"`～`"5xx"`，可以是列表，例如 `[200, "3xx"]` |
| `expect_json` | 无 | 对响应 JSON 的断言列表，格式与 `assert` 节点的 `assertions` 相同（见上文） |
| `until_ok` | `false` | 打开时，没有得到响应（连接失败、超时）或断言不通过就每 `poll` 秒重试一次，直到通过或超过 `wait` 秒 |
| `wait` | `300` | `until_ok` 时最多等多少秒 |
| `poll` | `1` | `until_ok` 时的重试间隔（秒） |

| 输出 | 说明 |
|---|---|
| `status` | 状态码 |
| `headers` | 响应头（对象）。名字都是小写；同名的多个响应头用 `, ` 连起来 |
| `json` | 响应内容是 JSON 且不超过 256 KiB 时，解析后的值 |
| `text` | 响应内容不是 JSON 或超过 256 KiB 时的文本，最多保留开头 256 KiB（截断时写一条警告日志） |
| `elapsed_ms` | 最后一次请求的耗时（毫秒） |

| 指标 | 单位 | 说明 |
|---|---|---|
| `elapsed_ms`（主指标） | ms | 每次请求的耗时 |

- 先检查状态码，再检查 `expect_json`。不满足时节点失败，错误信息写明请求方法和地址、状态码，以及不在 `expect_status` 里时响应的开头、不通过的断言（与 `assert` 一样逐条列出）。响应不是 JSON 而填了 `expect_json` 时也失败。
- `expect_json` 检查完整的响应 JSON：超过 256 KiB、输出里只有截断的 `text` 时也一样。
- 没有得到响应时（连接被拒绝、请求超时、证书校验失败）节点失败，错误信息写明原因。
- `until_ok` 重试时，原因变化时写一条日志（第几次、为什么不满足）；超过 `wait` 时失败，错误信息是请求次数和最后一次不满足的原因。每次请求最多等 `request_timeout` 秒，所以实际可能比 `wait` 多等一次请求的时间。
- 不跟随重定向：3xx 响应按原样检查，需要时把它写进 `expect_status`。
- 走 Agent 的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量设置的代理。
- 请求头和请求体在运行页面上对所有人可见，不要直接写密钥。

例：被测服务用 `start_process` 启动后，等它的健康检查接口返回 `{"status": "ok"}`，最多等 2 分钟。节点 `ready` 的参数：

```json
{
  "url": "http://127.0.0.1:8080/health",
  "expect_json": [{ "path": "$.status", "op": "eq", "value": "ok" }],
  "until_ok": true,
  "wait": 120,
  "poll": 2
}
```

服务启动前连接被拒绝也会重试。下单接口要返回 201 和订单号时，节点 `order` 的参数：

```json
{
  "method": "POST",
  "url": "http://127.0.0.1:8080/api/orders",
  "headers": { "X-Request-Id": "sfly-smoke" },
  "json": { "sku": "A-100", "count": 2 },
  "expect_status": 201,
  "expect_json": [{ "path": "$.order_id", "op": "exists" }]
}
```

后面的节点引用 `order` 的输出 `json` 拿到整个响应，或者用 `assert` 对它做更多检查。
