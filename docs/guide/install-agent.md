# 安装 Agent

sfly Agent 是测试机上执行任务的程序：它主动连接控制面，按场景的安排在本机执行节点。任务在哪台机器上的 Agent 执行，就在哪个环境里执行。

要求：Linux（x86_64 或 aarch64，WSL 也可以），能访问控制面 `{{SFLY_URL}}`，有 `curl`（或 `wget`）。uv 和 Python 不用预装。

## 安装

在测试机上运行：

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name "$(uname -n)"
```

安装脚本识别 CPU 架构，从控制面下载 sfly Agent {{SFLY_VERSION}} 并校验 sha256，写好配置，注册并启动 systemd 服务。

- `--name`：Agent 名称，全局唯一，场景按名称选择 Agent。上面的命令用主机名，也可以换成别的名称。
- `--token '<令牌>'`：控制面配置了注册令牌时必填，向平台管理员索取。令牌不对时 Agent 打印 `invalid agent token` 后退出。
- `--slots <数量>`：同时执行的任务上限，默认 4。
- 完整参数：`curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --help`。

Agent 连上控制面后出现在 [Agent 管理](/agents) 页面。首次启动时它会准备运行环境，需要一两分钟：

1. 没有 uv 时从控制面配置的 GitHub Release 镜像安装 uv（到 `~/.sfly/bin/uv`）。uv 只在运行安装脚本后和 Agent 自动更新后的首次启动时各更新一次。
2. 用 Python 3.13 创建共享 venv（`~/.sfly/venv`），Python 同样从镜像下载。之后不会主动升级 Python。
3. 从控制面安装 SDK 运行时，然后开始接任务。

## 服务

用普通用户运行安装脚本时注册用户级服务，用 root 运行时注册系统级服务（`/etc/systemd/system/sfly-agent.service`）。查看状态和日志（系统级服务去掉 `--user`）：

```sh
systemctl --user status sfly-agent
journalctl --user -u sfly-agent -f
```

用户级服务只在你登录期间运行。要让它开机就运行：

```sh
loginctl enable-linger "$(id -un)"
```

没有 systemd 时（容器、部分 WSL），安装脚本只打印前台启动命令，自己运行它：

```sh
~/.sfly/bin/sfly-agent
```

环境准备失败（装不了 uv、创建不了 venv）时，Agent 打印失败的命令、完整输出和用到的镜像地址，以退出码 78 退出，systemd 不会再重启它。把这段输出发给平台管理员。

## 开发机：`--dev`

在写节点包的机器上加 `--dev`，除了 Agent，再装好 uv（PATH 上没有时，装到 `~/.local/bin`）和 `sfly` 命令行 {{SFLY_VERSION}}（`uv tool install`，从控制面的 sfly 索引 `{{SFLY_URL}}/simple/` 安装）。联调用的 Agent 名称约定为 `dev-<用户名>-<主机名>`，不和测试机上的 Agent 重名：

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name "dev-$(id -un)-$(uname -n)" --dev
```

安装脚本提示 `~/.local/bin` 不在 PATH 上时，把它加进 shell 配置（例如 `~/.bashrc`），当前终端里先执行：

```sh
export PATH="$HOME/.local/bin:$PATH"
sfly --version
```

`sfly --version` 输出 `sfly {{SFLY_VERSION}}` 即安装完成。`sfly` 记住了控制面地址（`~/.sfly/agent.env`），`sfly init`、`sfly dev`、`sfly publish` 不用再传 `--server`。控制面升级后重新运行同一条安装命令，`sfly` 就升级到控制面的版本。

## 配置与文件

所有东西都在 `~/.sfly` 下。要换成别的目录，运行安装脚本时设置环境变量 `SFLY_HOME`（systemd 服务会记住它；前台启动 Agent 和运行 `sfly` 时也要设置）：

| 位置 | 内容 |
|---|---|
| `bin/sfly-agent` | Agent 二进制 |
| `bin/uv` | Agent 管理的 uv |
| `agent.env` | 配置：每行 `KEY=VALUE`，安装脚本写入控制面地址、名称、令牌、槽位数 |
| `venv/` | 共享 venv：SDK 运行时和所有节点包都装在这里 |
| `work/` | 任务工作目录，以及 `sfly dev` 连接的本地 socket `agent.sock` |

`agent.env` 里的键就是 Agent 参数对应的环境变量（`SFLY_AGENT_NAME`、`SFLY_TOKEN`、`SFLY_SLOTS`……）。命令行参数和环境变量优先于 `agent.env`。全部参数和对应的环境变量：

```sh
~/.sfly/bin/sfly-agent --help
```

改完 `agent.env` 后重启 Agent（`systemctl --user restart sfly-agent`）。重新运行安装脚本会整个覆盖 `agent.env`：需要的令牌要再传一次 `--token`，自己加的键要再加一次。

## 版本与自动更新

Agent 和控制面必须是同一个版本。控制面升级（或回滚）后，版本不一致的 Agent 仍然保持连接，手上的任务照常跑完，但不再接新任务；[Agent 管理](/agents) 页面显示 Agent 和控制面各自的版本号和更新状态。用安装脚本安装的 Agent 自动更新到控制面的版本，状态列依次显示：

1. 「更新中 · 下载新版本」：从控制面下载同版本的 Agent，校验 sha256 并试运行。
2. 「更新中 · 等待 N 个任务结束」：等手上的任务跑完、结果都上报给控制面。
3. 「更新中 · 替换并重新启动」：替换 `bin/sfly-agent`（旧版本保留为 `bin/sfly-agent.prev`），以原来的参数重新启动，重新连上后恢复接任务。更新后的首次启动更新一次 uv。

有长任务时不必一直等：在「下载新版本」或「等待任务结束」时，Agent 管理页的这一行有「立即更新」按钮。确认框列出会被终止的任务；确认后 Agent 按取消流程终止它们（任务以 `agent_lost` 失败，配置了重试的节点在更新后的 Agent 上重新执行），然后立即替换。更新失败、需要手动升级的 Agent 没有这个按钮。

下载、校验或替换失败时显示「更新失败」和原因，Agent 继续以旧版本保持连接。用 `sfly dev` 加载的开发版本在更新后仍然有效。

新版本连续 3 次启动失败（崩溃后被 systemd 重启，或连上控制面却握手失败；连不上控制面不算）时，Agent 恢复 `bin/sfly-agent.prev` 里的旧版本，把这个版本记为坏版本，页面上显示「更新失败」和原因。之后 Agent 只保持连接、不接任务，也不再自动尝试这个版本；控制面换成其他版本后重新尝试。替换后执行新版本这一步本身就失败时，Agent 同样恢复旧版本，在日志里写出手动处理步骤并退出；用 systemd 运行时会被重新拉起，前台运行时要自己重新启动。

以下情况 Agent 不自动更新，页面上显示「需要手动升级」和原因：

- 配置了不自动更新：

  ```sh
  echo 'SFLY_NO_AUTO_UPDATE=1' >> ~/.sfly/agent.env
  ```

  然后重启 Agent。需要严格控制版本的机器这样设置，升级时自己重新运行安装命令。
- Agent 二进制不在 `$SFLY_HOME/bin`（默认 `~/.sfly/bin`）下（不是安装脚本安装的），或者这个目录不可写。

手动升级就是重新运行安装命令，名称、令牌和原来一样。

**旧 Agent 首次升级**：在有安装脚本之前部署的 Agent（从 GitHub Release 下载、自己写启动参数或 systemd 服务）没有自动更新能力，需要手动升级一次：停掉旧的进程或服务，在同一台机器上用原来的名称运行上面的安装命令。之后的版本都会自动更新。旧的 venv 和工作目录不再使用，可以删除。

## 镜像（部署控制面的人看）

测试机通常访问不到 PyPI 和 GitHub。镜像地址只在控制面上配置一次，Agent 连上控制面时拿到，`sfly init` 也写进新项目：

| 控制面环境变量 | 用途 |
|---|---|
| `SFLY_PYPI_MIRROR` | PyPI 镜像：Agent 安装节点包的依赖、开发机安装 `sfly` 命令行的依赖、项目的 `uv sync` |
| `SFLY_GITHUB_RELEASE_MIRROR` | GitHub Release 镜像：安装 uv、下载 Python（python-build-standalone） |

中科大镜像的配置（写进部署目录的 `.env`）：

```ini
SFLY_PYPI_MIRROR=https://mirrors.ustc.edu.cn/pypi/simple
SFLY_GITHUB_RELEASE_MIRROR=https://mirrors.ustc.edu.cn/github-release
```

不配置时用 uv 的官方来源，能访问公网的环境不用配置。单台 Agent 可以用 `--index-url`（`SFLY_INDEX_URL`）覆盖 PyPI 镜像，用 `--uv`（`SFLY_UV`）指定自己的 uv，这时 Agent 不再安装和更新 uv。
