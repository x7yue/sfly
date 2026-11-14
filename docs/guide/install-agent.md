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
- `--token '<令牌>'`：控制面配置了注册令牌时必填，向平台管理员索取。令牌不对时 Agent 打印 `invalid agent token` 后退出。推荐改用环境变量 `SFLY_TOKEN` 传给安装脚本，令牌不会留在 shell 历史和进程列表里（见下面的例子）。
- `--slots <数量>`：同时执行的任务上限，默认 4。
- `--listen-port <端口>`、`--public-address <地址>`：供其它 Agent 连接的端口（默认 50052）和对外地址，见下面的「供其它 Agent 连接的端口」。
- `--no-auto-update`：不自动更新（见「版本与自动更新」）。
- 完整参数：`curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --help`。

用环境变量传令牌：先读入令牌（粘贴后回车，输入不显示），再运行安装命令：

```text
read -rs SFLY_TOKEN && export SFLY_TOKEN
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name "$(uname -n)"
```

### 用 sudo 安装（系统级服务）

用 `sudo` 运行安装脚本，注册的是系统级服务：开机就运行，不依赖有人登录。机器跑不了用户级服务时（见下面「排查」里的 `Failed to get D-Bus connection`）也用这种方式：

```text
curl -fsSL {{SFLY_URL}}/install.sh | sudo sh -s -- --name "$(uname -n)"
```

- Agent 以 root 运行，文件在 root 的家目录下（通常是 `/root/.sfly`，以安装脚本最后打印的路径为准），下面写的 `~/.sfly` 都指这个目录。之后升级、改配置也要用 `sudo`。
- `sudo` 默认不传递环境变量：用环境变量传令牌、镜像覆盖、`SFLY_USER_AGENT` 时，用 `--preserve-env` 列出它们，例如 `sudo --preserve-env=SFLY_TOKEN sh -s -- --name "$(uname -n)"`；要把文件放到别的目录，写成 `sudo SFLY_HOME=/opt/sfly sh -s -- …`。
- 同一台机器上之前用普通用户装过时，先停掉那个 Agent（`systemctl --user disable --now sfly-agent`，或结束前台进程），否则两个同名的 Agent 会同时连接控制面。

Agent 连上控制面后出现在 [Agent 管理](/agents) 页面。首次启动时它会准备运行环境，需要一两分钟：

1. 没有 uv 时从 GitHub Release 镜像（控制面配置的，或本机覆盖的，见下面的「镜像」）安装 uv（到 `~/.sfly/bin/uv`）。uv 只在运行安装脚本后和 Agent 自动更新后的首次启动时各更新一次。
2. 用 Python 3.13 创建共享 venv（`~/.sfly/venv`），Python 从 Python 下载镜像（默认由 GitHub Release 镜像推导）下载。之后不会主动升级 Python。
3. 从控制面安装 SDK 运行时，然后开始接任务。

这段时间叫「准备环境」，每次 Agent 连上控制面都会先走一遍（环境已经就绪时只是几项检查，很快结束）。准备环境期间 Agent 算在线，但不接任务：派给它的任务留在队列里，不占槽位，准备好之后按排队顺序派发，不会因为准备环境慢而失败。[Agent 管理](/agents) 页面上，状态「在线」旁边显示「准备环境中 · 已 2 分 10 秒」，时长从 Agent 连上控制面算起，按控制面的时间计算；准备好之后标记消失。`sfly agent list` 的状态列写「在线（准备环境中，已 2 分 10 秒）」，`--json` 里的 `preparing_since` 是开始准备环境的时间。准备了很久还没有结束时，到那台机器上看 Agent 的日志（见下面的「服务」），多半卡在下载 uv 或 Python，检查镜像和网络。准备环境失败时 Agent 退出，页面上显示离线。

## 服务

用普通用户运行安装脚本时注册用户级服务（`~/.config/systemd/user/sfly-agent.service`），用 root 或 `sudo` 运行时注册系统级服务（`/etc/systemd/system/sfly-agent.service`）。查看用户级服务的状态和日志：

```sh
systemctl --user status sfly-agent
journalctl --user -u sfly-agent -f
```

系统级服务去掉 `--user`，前面加 `sudo`：

```text
sudo systemctl status sfly-agent
sudo journalctl -u sfly-agent -f
```

用户级服务只在你登录期间运行。要让它开机就运行：

```sh
loginctl enable-linger "$(id -un)"
```

没有 systemd 时（容器、部分 WSL），安装脚本只打印前台启动命令，自己运行它：

```sh
~/.sfly/bin/sfly-agent
```

环境准备失败（装不了 uv、创建不了 venv）时，Agent 打印失败的命令、完整输出和用到的镜像地址（每个地址标明来自控制面还是本机覆盖），以退出码 78 退出，systemd 不会再重启它。把这段输出发给平台管理员。刚自动更新上来的新版本例外：它以退出码 1 退出，由 systemd 重启，连续失败后恢复旧版本（见下面的「版本与自动更新」）。

## 开发机：`--dev`

在写节点包的机器上加 `--dev`，除了 Agent，再装好 uv（PATH 上没有时，装到 `~/.local/bin`）和 `sfly` 命令行 {{SFLY_VERSION}}（`uv tool install`，从控制面的 sfly 索引 `{{SFLY_URL}}/simple/` 安装）。加 `--dev` 时 `--name` 可以省略，联调用的 Agent 默认叫 `dev-<用户名>-<主机名>`（主机名不带域名），不和测试机上的 Agent 重名：

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --dev
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
| `agent.env` | 配置：每行 `KEY=VALUE`，安装脚本写入控制面地址、名称、令牌、槽位数、是否自动更新、本机的镜像覆盖 |
| `venv/` | 共享 venv：SDK 运行时和所有节点包都装在这里 |
| `work/` | 任务工作目录（每个任务一个子目录），以及 `sfly dev` 连接的本地 socket `agent.sock` |
| `procs/` | 后台进程目录（每次运行一个子目录）：节点启动的、节点结束后继续运行的进程（例如标准节点 `start_process`）的日志 |

`agent.env` 里的键就是 Agent 参数对应的环境变量（`SFLY_AGENT_NAME`、`SFLY_TOKEN`、`SFLY_SLOTS`……）。命令行参数和环境变量优先于 `agent.env`。全部参数和对应的环境变量：

```sh
~/.sfly/bin/sfly-agent --help
```

改完 `agent.env` 后重启 Agent（`systemctl --user restart sfly-agent`）。重新运行安装脚本时只改写它管理的键（`SFLY_SERVER`、`SFLY_CONTROL_PLANE_URL`、`SFLY_AGENT_NAME`、`SFLY_TOKEN`、`SFLY_SLOTS`、`SFLY_LISTEN_PORT`、`SFLY_PUBLIC_ADDRESS`、`SFLY_NO_AUTO_UPDATE`，以及镜像覆盖 `SFLY_INDEX_URL`、`SFLY_GITHUB_RELEASE_MIRROR`、`SFLY_PYTHON_INSTALL_MIRROR`），自己加的键保留；没有再传 `--token`、`--slots`、`--listen-port`、`--public-address`、`--no-auto-update`、没有再设置镜像环境变量时沿用原来的值。

任务目录里有任务的输入、输出、产物，以及标准输出 / 标准错误的副本 `stdout.log` / `stderr.log`（完整日志在控制面）。副本每个文件 8 MiB，写满后改名为 `stdout.log.1` / `stderr.log.1`（覆盖旧的）再写新文件，每个流最多占 16 MiB。任务结束、结果交给控制面后，任务目录默认保留 7 天：Agent 启动时和之后每小时删除超过保留期的目录。保留期按真实流逝的时长计算，修改 Agent 机器的系统时间不会让目录提前被删或一直不删；Agent 或机器重启后，已有的目录从启动时重新计时。用 `SFLY_TASK_DIR_RETENTION`（参数 `--task-dir-retention`）修改，例如在 `agent.env` 里加一行（改完重启 Agent）：

```ini
SFLY_TASK_DIR_RETENTION=24h
```

可以写成 `30m`、`24h`、`7d` 这样；`0` 表示任务结束后立即删除。正在执行的任务、`.dev` 等以点开头的目录和 `agent.sock` 不会被删除。

后台进程目录 `procs/<运行 ID>/` 按同一个保留期清理：从这次运行在这个 Agent 上的最后一个任务结束时开始计时（Agent 重启后从启动时重新计时），超过保留期、而且这次运行没有任务还在这个 Agent 上执行时删除，后台进程还在写日志时不会被删。保留期为 `0` 时，运行在这个 Agent 上的任务都结束后，下一次扫描（每小时）就删除，哪怕后台进程还在运行。用 `SFLY_PROCS_DIR`（参数 `--procs-dir`）把它放到别处。

## 供其它 Agent 连接的端口

节点可以调用另一台 Agent 的 Agent 能力（例如读取那台机器上的文件），这时两台 Agent 直接通信，数据不经过控制面。为此每台 Agent 都在一个端口上等其它 Agent 连接，默认是 50052，在所有网卡上监听。

**这个端口上的接口没有认证，也不加密**：能连上这个端口的机器就能调用这台 Agent 的能力，权限就是 Agent 进程的权限。只在内网使用，不要让外网访问到这个端口。

- **端口**：安装时用 `--listen-port <端口>` 修改（写进 `agent.env` 的 `SFLY_LISTEN_PORT`），机器上 50052 已被别的程序占用，或者要和防火墙规则一致时设置。防火墙要放行这个端口，让其它测试机上的 Agent 连得进来。
- **对外地址**：其它 Agent 用来连接这台 Agent 的地址。默认是控制面看到的这台 Agent 的连接来源地址，大多数机器不用配置。机器有多块网卡（连控制面和连其它测试机走的不是同一块）、控制面经过代理或地址转换才能访问（控制面看到的不是这台机器的地址）时，安装时用 `--public-address <地址>` 指定（写进 `SFLY_PUBLIC_ADDRESS`）。地址是 IP 地址或主机名，不带协议和端口；主机名要能被其它测试机解析。

例如这台机器在测试网里的地址是 `10.20.30.40`，端口用 6000：

```text
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name "$(uname -n)" --listen-port 6000 --public-address 10.20.30.40
```

已经安装过的机器可以直接改 `agent.env`（改完重启 Agent）：

```ini
SFLY_LISTEN_PORT=6000
SFLY_PUBLIC_ADDRESS=10.20.30.40
```

[Agent 管理](/agents) 页面的「对外地址」列显示每台 Agent 的地址和端口（安装时显式配置的标明「安装时配置」），「能力」列显示它支持的能力及版本。

端口被占用（或因为别的原因监听不了）时，Agent 照常连接控制面、执行任务，只是它的能力不能被其它 Agent 调用：Agent 管理页的「能力」列显示「不能被其它 Agent 调用」和原因（例如「端口 50052 已被占用」）。释放端口或换一个端口后重启 Agent。不监听端口的旧版本 Agent 升级后才有能力。

验证两台 Agent 之间是通的：在另一台测试机上连这台 Agent 的地址和端口（以 Agent 管理页显示的为准），能连上说明网络和防火墙都放行了：

```text
nc -vz 10.20.30.40 50052
```

没有 `nc` 时可以用 bash：`timeout 3 bash -c '</dev/tcp/10.20.30.40/50052' && echo 通`。连不上时依次检查：Agent 管理页上这台 Agent 有没有显示「不能被其它 Agent 调用」，这台机器上 `ss -ltnp | grep 50052` 能不能看到 `sfly-agent` 在监听，两台机器之间的防火墙有没有放行这个端口，对外地址是不是另一台机器能访问到的地址。

## 版本与自动更新

Agent 和控制面必须是同一个版本。控制面升级（或回滚）后，版本不一致的 Agent 仍然保持连接，手上的任务照常跑完，但不再接新任务；[Agent 管理](/agents) 页面显示 Agent 和控制面各自的版本号和更新状态。用安装脚本安装的 Agent 自动更新到控制面的版本，状态列依次显示：

1. 「更新中 · 下载新版本」：从控制面下载同版本的 Agent，校验 sha256 并试运行。
2. 「更新中 · 等待 N 个任务结束」：等手上的任务跑完、结果都上报给控制面。
3. 「更新中 · 替换并重新启动」：替换 `bin/sfly-agent`（旧版本保留为 `bin/sfly-agent.prev`），以原来的参数重新启动，重新连上后恢复接任务。更新后的首次启动更新一次 uv。

有长任务时不必一直等：在「下载新版本」或「等待任务结束」时，Agent 管理页的这一行有「立即更新」按钮。确认框列出会被终止的任务；确认后 Agent 按取消流程终止它们（任务以 `agent_lost` 失败，配置了重试的节点在更新后的 Agent 上重新执行），然后立即替换。更新失败、需要手动升级的 Agent 没有这个按钮。

下载、校验或替换失败时（下载 30 秒没有收到数据也算）显示「更新失败」和原因，Agent 继续以旧版本保持连接，下次重新连上控制面时再试。用 `sfly dev` 加载的开发版本在更新后仍然有效。

新版本连续 3 次启动失败时，Agent 恢复 `bin/sfly-agent.prev` 里的旧版本，把这个版本记为坏版本，页面上显示「更新失败」和原因。启动失败指新版本在连上控制面、准备好运行环境之前退出（读不了配置、崩溃、环境准备失败，之后被 systemd 重启），或连上控制面却握手失败；连不上控制面不算。之后 Agent 只保持连接、不接任务，也不再自动尝试这个版本；控制面换成其他版本，或回到 Agent 现在的版本之后，会重新尝试。替换后执行新版本这一步本身就失败时，Agent 同样恢复旧版本，在日志里写出手动处理步骤并退出；用 systemd 运行时会被重新拉起，前台运行时要自己重新启动。

以下情况 Agent 不自动更新，页面上显示「需要手动升级」和原因：

- 配置了不自动更新：安装时加 `--no-auto-update`（`agent.env` 里写入 `SFLY_NO_AUTO_UPDATE=1`；也可以自己写这一行再重启 Agent，值可以是 `1`/`true`/`yes`）。需要严格控制版本的机器这样设置，升级时自己重新运行安装命令，这个设置会保留；要恢复自动更新，删掉 `agent.env` 里的这一行再重启 Agent。
- Agent 二进制不在 `$SFLY_HOME/bin`（默认 `~/.sfly/bin`）下（不是安装脚本安装的），或者这个目录不可写。

手动升级就是重新运行安装命令，名称、令牌和原来一样。

**旧 Agent 首次升级**：在有安装脚本之前部署的 Agent（从 GitHub Release 下载、自己写启动参数或 systemd 服务）没有自动更新能力，需要手动升级一次：停掉旧的进程或服务，在同一台机器上用原来的名称运行上面的安装命令。之后的版本都会自动更新。旧的 venv 和工作目录不再使用，可以删除。

## 镜像

测试机通常访问不到 PyPI 和 GitHub。镜像地址由部署控制面的人在控制面上配置一次，Agent 连上控制面时拿到，`sfly init` 也写进新项目：

| 控制面环境变量 | 用途 |
|---|---|
| `SFLY_PYPI_MIRROR` | PyPI 镜像：Agent 安装节点包的依赖、开发机安装 `sfly` 命令行的依赖、项目的 `uv sync` |
| `SFLY_GITHUB_RELEASE_MIRROR` | GitHub Release 镜像：安装 uv、下载 Python（python-build-standalone） |

中科大镜像的配置（写进部署目录的 `.env`）：

```ini
SFLY_PYPI_MIRROR=https://mirrors.ustc.edu.cn/pypi/simple
SFLY_GITHUB_RELEASE_MIRROR=https://mirrors.ustc.edu.cn/github-release
```

不配置时用 uv 的官方来源，能访问公网的环境不用配置。单台 Agent 可以用 `--uv`（`SFLY_UV`）指定自己的 uv，这时 Agent 不再安装和更新 uv。

### 单台机器覆盖镜像

个别机器访问不了控制面配置的镜像时（网络不同，或镜像站拒绝这台机器的请求），可以只在这台机器上换成别的镜像，不影响其他 Agent 和项目。有三个覆盖项，名字和 Agent 参数对应的环境变量相同：

| 本机覆盖 | Agent 参数 | 用途 |
|---|---|---|
| `SFLY_INDEX_URL` | `--index-url` | PyPI 镜像：Agent 安装节点包的依赖（Agent 访问 PyPI 只有这一处）、`--dev` 安装 `sfly` 命令行的依赖、`sfly init` 写进新项目 |
| `SFLY_GITHUB_RELEASE_MIRROR` | `--github-release-mirror` | GitHub Release 镜像：安装和更新 uv；没有覆盖 Python 下载镜像时也用来下载 Python |
| `SFLY_PYTHON_INSTALL_MIRROR` | `--python-install-mirror` | Python 下载镜像，直接作为 uv 的 `UV_PYTHON_INSTALL_MIRROR`（以 `/astral-sh/python-build-standalone/` 结尾） |

优先级：命令行参数 > 环境变量 > `agent.env` > 控制面配置的镜像。Python 下载镜像没有覆盖时，从（覆盖后的）GitHub Release 镜像推导为 `<镜像>/astral-sh/python-build-standalone/`，所以可以只换 Python 的来源，uv 仍从控制面配置的镜像安装。`sfly init` 按同样的规则读取环境变量和 `~/.sfly/agent.env`，同一台机器上的项目和 Agent 用同样的镜像。

运行安装脚本时设置这些环境变量（注意设在 `sh` 前面，不是 `curl` 前面），安装脚本在 `--dev` 安装 uv 和 `sfly` 命令行时使用它们，并写进 `agent.env`；之后重新运行安装脚本不用再设置，原来的值保留。要取消覆盖，删掉 `agent.env` 里的那一行再重启 Agent。

例如控制面配置的是中科大镜像，而中科大拒绝 Omarchy 上 uv 发出的请求（uv 把发行版名写进 User-Agent，返回 403；curl 不受影响，所以 uv 本身仍能从中科大安装）。在这台机器上把 PyPI 换成清华、Python 换成南大，uv 仍从中科大安装：

```text
curl -fsSL {{SFLY_URL}}/install.sh | \
  SFLY_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  SFLY_PYTHON_INSTALL_MIRROR=https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/ \
  sh -s -- --dev
```

安装脚本写进 `agent.env` 的两行（已经安装过的机器也可以自己加这两行，再重启 Agent）：

```ini
SFLY_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
SFLY_PYTHON_INSTALL_MIRROR=https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/
```

已经用控制面的镜像生成的项目不会自动改变：把 `pyproject.toml` 里 `[tool.uv]` 的 `python-install-mirror` 和名为 `pypi-mirror` 的索引地址改成同样的值，或者重新 `sfly init`。

### 下载用的 User-Agent

镜像站会封禁 curl、wget 的部分默认 User-Agent（例如中科大对老版本 curl、wget 返回 403，要求换成能看出下载用途或所在机构的值，见 [ustclug/discussions#479](https://github.com/ustclug/discussions/issues/479)）。所以安装脚本下载 Agent、`--dev` 安装 uv，以及 Agent 安装和更新 uv 时，curl、wget 都带 `sfly-agent/<版本>`。uv 官方安装脚本里的 curl、wget 改不了参数，所以运行它时用临时的 `CURL_HOME`、`WGETRC` 配置文件带上同一个 User-Agent，原有的 `~/.curlrc`、`~/.wgetrc` 内容照抄过去。uv 自己发出的请求（下载 Python、安装依赖）带的是 `uv/<版本>`，不受这一项影响。

要换成自己机构的标识，设置 `SFLY_USER_AGENT`（Agent 参数 `--user-agent`，优先级同上）。值只能包含可打印 ASCII 字符，不能有 `"` 和 `\`。和镜像覆盖一样，运行安装脚本时设在 `sh` 前面，会写进 `agent.env`：

```text
curl -fsSL {{SFLY_URL}}/install.sh | SFLY_USER_AGENT=acme-lab-sfly/1.0 sh -s -- --name <名称>
```

已经安装过的机器可以在 `agent.env` 里加一行 `SFLY_USER_AGENT=acme-lab-sfly/1.0`，再重启 Agent。

## 排查

先看 Agent 的日志：服务用上面「服务」里的 `journalctl` 命令，前台运行时就是终端输出。环境准备失败时日志末尾是一份报告（失败的命令、完整输出、用到的镜像），连同下面对应条目的检查结果一起发给平台管理员。

### 前台能运行，服务运行不了

服务和你在终端里运行的 Agent 环境不同，逐项对比：

- **`SFLY_HOME` 不同**：用 `sudo` 安装的服务用 root 的 `/root/.sfly`，你在终端里运行的用你自己的 `~/.sfly`。已经准备好 venv 的那个不用再下载 Python，新的那个要从头准备，失败时只有它报错。日志里的路径、`ls ~/.sfly/venv` 能看出是哪个。
- **环境变量不同**：systemd 不读 `~/.bashrc`、`/etc/profile`，写在里面的代理（`http_proxy`、`https_proxy`）、`PATH` 对服务无效。需要时用 `systemctl edit` 加到服务里（写法见下面的 `UV_LIBC`）。
- **用户不同**：系统级服务以 root 运行，用户级服务以安装它的用户运行。

### 下载 Agent 失败：`curl: (23) Failed writing body`

curl 已经收到控制面的数据，但写不进本地文件，原因在测试机这一侧：磁盘或配额满了，或者输出路径不可写、是一个已有的目录。安装脚本把 Agent 下载到 `~/.sfly/bin`，下面的命令检查空间、确认控制面这一侧正常（应该输出 `200` 和几 MB 的大小）：

```text
df -h ~ /tmp
curl -A sfly-agent/{{SFLY_VERSION}} -o /dev/null -w '%{http_code} %{size_download}\n' {{SFLY_URL}}/agent/binaries/{{SFLY_VERSION}}/x86_64
```

aarch64 的机器把最后的 `x86_64` 换成 `aarch64`。

### 注册服务失败：`Failed to get D-Bus connection: No such file or directory`

安装脚本用 `systemctl --user` 注册用户级服务，它要连接你这个用户的 systemd 实例（`/run/user/<uid>/bus`），这里没找到。常见于 CentOS / RHEL 7（systemd 219 对用户级服务支持不全），或者用 `su`、`sudo -u` 切换过来的用户（没有建立登录会话）。Agent 已经装好，只是没有注册成服务。检查：

```text
systemctl --version | head -1
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"; ls -l /run/user/$(id -u)/bus
```

任选一种：

- 有 `sudo` 权限：按上面「用 sudo 安装（系统级服务）」重新安装，注册系统级服务（推荐）。
- systemd 较新、只是缺少登录会话：直接用 SSH 登录这个用户（不要经过 `su`），执行 `loginctl enable-linger "$(id -un)"`，再运行一次安装命令。
- 都不行：安装时加 `--no-service`，用 `tmux` 或 `nohup` 运行安装脚本打印的前台启动命令。机器重启后要自己再启动。

### 环境准备失败：`Could not detect either glibc version nor musl libc version`

Agent 用 uv 下载 Python 之前，uv 要识别这台机器的 C 库是 glibc 还是 musl：它读 `/bin/sh` 用的动态链接器，看链接器的文件名或运行 `链接器 --version` 的输出。在个别系统上这几步都失败，就报这个错。只在需要下载 Python 时（新的 `SFLY_HOME`、venv 还没建好）才会遇到。检查（第一条输出 `glibc 2.xx` 说明是 glibc）：

```text
getconf GNU_LIBC_VERSION
cat /etc/os-release | head -3; getenforce
readelf -l /bin/sh | grep interpreter
ls -l /lib64/ld-linux-x86-64.so.2; /lib64/ld-linux-x86-64.so.2 --version | head -1
~/.sfly/bin/uv python list 3.13 -vv 2>&1 | grep -iE 'libc|musl|ld' | head -20
```

aarch64 的机器链接器是 `/lib/ld-linux-aarch64.so.1`；`sudo` 安装的把 `~/.sfly` 换成 `/root/.sfly`，命令前加 `sudo`。

确认是 glibc 后，可以用 uv 的环境变量 `UV_LIBC=gnu` 跳过识别（musl 的机器写 `musl`）。它不是 Agent 的参数，不能写进 `agent.env`，要加到服务里：

```text
sudo systemctl edit sfly-agent         # 用户级服务：systemctl --user edit sfly-agent
```

在打开的编辑器里写入下面两行，保存后重启服务（`sudo systemctl restart sfly-agent`）：

```ini
[Service]
Environment="UV_LIBC=gnu"
```

前台运行时写在命令前面：`UV_LIBC=gnu ~/.sfly/bin/sfly-agent`。
