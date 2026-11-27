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
- `--token '<凭据>'`：这台 Agent 的 **Agent 凭据**（`sfly_agt_` 开头），向平台管理员索取，签发办法见下面的「Agent 凭据」。凭据只对签发时指定的那个名字有效，所以 `--name` 要和它一致；凭据不对（写错、被吊销、名字对不上）时控制面拒绝这台 Agent 的连接，Agent 不退出，一直重试（见下面的「被控制面拒绝」）。这不是个人令牌（命令行登录用的个人令牌见「用命令行操作平台」）。推荐改用环境变量 `SFLY_TOKEN` 传给安装脚本，凭据不会留在 shell 历史和进程列表里（见下面的例子）。过渡期里控制面还接受共享注册令牌、以及不带凭据的已登记的 Agent（只在本版本内，下一个版本起拒绝，见「Agent 凭据」）。
- `--slots <数量>`：同时执行的任务上限，默认 4。
- `--listen-port <端口>`、`--public-address <地址>`：供其它 Agent 连接的端口（默认 50052）和对外地址，见下面的「供其它 Agent 连接的端口」。
- `--no-auto-update`：不自动更新（见「版本与自动更新」）。
- 完整参数：`curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --help`。

用环境变量传凭据：先读入凭据（粘贴后回车，输入不显示），再运行安装命令（`--name` 写签发凭据时指定的名字）：

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
- `sudo` 默认不传递环境变量：用环境变量传凭据、镜像覆盖、`SFLY_USER_AGENT` 时，用 `--preserve-env` 列出它们，例如 `sudo --preserve-env=SFLY_TOKEN sh -s -- --name "$(uname -n)"`；要把文件放到别的目录，写成 `sudo SFLY_HOME=/opt/sfly sh -s -- …`。
- 同一台机器上之前用普通用户装过时，先停掉那个 Agent（`systemctl --user disable --now sfly-agent`，或结束前台进程），否则两个同名的 Agent 会同时连接控制面。

Agent 连上控制面后出现在 [Agent 管理](/agents) 页面。首次启动时它会准备运行环境，需要一两分钟：

1. 没有 uv 时从 GitHub Release 镜像（控制面配置的，或本机覆盖的，见下面的「镜像」）安装 uv（到 `~/.sfly/bin/uv`）。uv 只在运行安装脚本后和 Agent 自动更新后的首次启动时各更新一次。
2. 用 Python 3.13 创建共享 venv（`~/.sfly/venv`），Python 从 Python 下载镜像（默认由 GitHub Release 镜像推导）下载。之后不会主动升级 Python。
3. 从控制面安装 SDK 运行时，然后开始接任务。

这段时间叫「准备环境」，每次 Agent 连上控制面都会先走一遍（环境已经就绪时只是几项检查，很快结束）。准备环境期间 Agent 算在线，但不接任务：派给它的任务留在队列里，不占槽位，准备好之后按排队顺序派发，不会因为准备环境慢而失败。[Agent 管理](/agents) 页面上，状态「在线」旁边显示「准备环境中 · 2m 10s」，时长从 Agent 连上控制面算起，按控制面的时间计算；准备好之后这段文字消失。`sfly agent list` 的状态列写「在线（准备环境中，已 2 分 10 秒）」，`--json` 里的 `preparing_since` 是开始准备环境的时间。准备了很久还没有结束时，到那台机器上看 Agent 的日志（见下面的「服务」），多半卡在下载 uv 或 Python，检查镜像和网络。准备环境失败时 Agent 退出，页面上显示离线。

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

## 被控制面拒绝

控制面会拒绝这几种连接：凭据无效或已被吊销、名字和凭据不一致、这台 Agent 被管理员停用、同名的带凭据的连接还在（用共享令牌或不带凭据的连接顶不掉它）。**Agent 不退出**：这些都是管理员在控制面改一下就会好的，退出了反而会被 systemd 每 5 秒拉起一次，等于快速重试。Agent 按 30 秒起翻倍、最长 5 分钟的间隔重试（每次实际等的是这个间隔的一半到全部，很多台 Agent 同时被拒绝时不会按同一个节奏一起重试），连上一次就回到起点；管理员改好之后它自己连上，不用去机器上重启。

原因（控制面回的说明，不含凭据）只在第一次被拒绝和原因变了的时候打一行到标准错误（服务用 `journalctl` 看，见上面的「服务」），恢复连接时再打一行。[Agent 管理](/agents) 页上这台 Agent 一直显示离线、日志里是「控制面拒绝了这台 Agent 的连接」，就是这种情况。

- **手上的任务照常跑完**：和连不上控制面时一样，被拒绝期间 Agent 手上已经在执行的任务不会被终止，跑完的结果留在 Agent 里；恢复连接后由控制面按握手决定继续还是放弃（被拒绝期间租约到期、已经按 `agent_lost` 失败并重新派发的任务，放弃）。所以**吊销凭据、停用一台 Agent 并不会停下它手上正在跑的任务**；要停下那台机器上的工作，得停掉那台机器上的 Agent 服务（用户级服务 `systemctl --user stop sfly-agent`，系统级服务 `sudo systemctl stop sfly-agent`，前台运行的按 Ctrl-C）。
- **前面有反向代理时**：代理自己回的 401、403（代理的认证没通过、被访问控制拦下……）Agent 分不出是代理还是控制面回的，同样按「被控制面拒绝」处理：不退出，按上面的间隔重试，日志里写的说明是代理回的。Agent 一直连不上、日志里是 401 或 403 时，先查代理的配置。
- **新版本被拒绝**：自动更新刚换上的新版本一启动就被拒绝，算这个新版本的一次失败，连续 3 次之后回滚，见「版本与自动更新」。

## 开发机：`--dev`

在写节点包的机器上加 `--dev`，除了 Agent，再装好 uv（PATH 上没有时，装到 `~/.local/bin`）和 `sfly` 命令行 {{SFLY_VERSION}}（`uv tool install`，从控制面的 sfly 索引 `{{SFLY_URL}}/simple/` 安装）。**加 `--dev` 又不给 `--name` 时，这台 Agent 是你自己的开发 Agent**：装好 `sfly` 之后安装脚本用你的登录向控制面注册，名字由控制面按你的登录生成（`dev-<登录名>-<主机>`，主机是这台机器的主机名，不带域名，只留小写字母、数字和连字符），凭据记在你名下，一起写进 `agent.env`。名字里有你的登录名，所以不会和测试机上的 Agent、别人的开发 Agent 重名。

注册要用你自己的身份，所以先准备好登录：在控制台账号菜单的「令牌」页签发一个个人令牌，读进环境变量（粘贴后回车，输入不显示）：

```text
read -rs SFLY_API_TOKEN && export SFLY_API_TOKEN
```

然后运行：

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --dev
```

没有设置令牌时：在终端里运行，安装脚本让你 `sfly login`（问登录名和密码）再继续；没有终端（脚本、CI、不带 `-t` 的 ssh）就**直接失败**并写明怎么办，不会等着输入。失败时 Agent 二进制和 `sfly` 命令行已经装好，设置好令牌（或在这台机器上 `sfly login`）之后重新运行同一条命令即可。

- **重新运行（升级）**：`agent.env` 里已经有开发 Agent 的名字（`dev-` 开头）和 **Agent 凭据**（`sfly_agt_` 开头）时沿用，不再注册（同一个人在同一个项目里用同一个主机名只能注册一次）；`agent.env` 里是共享令牌（旧版本装的）不算，照常注册新的。要换成新的：先 `sfly agent revoke-dev <名称>` 吊销旧凭据，再删掉 `agent.env` 里的 `SFLY_AGENT_NAME` 和 `SFLY_TOKEN` 两行，重新运行。
- **名字被占用**：注册时控制面回「已经有一台叫……」，安装脚本失败（Agent 二进制和 `sfly` 命令行已经装好，没有写 `agent.env`），写明办法，选一个后重新运行同一条命令：加 `--dev-host <另一个主机名>`，名字里「主机」那一段就用它（两台机器的主机名一样时用这个）；如果这个名字是你自己以前注册的开发 Agent（比如换了机器或删了 `agent.env`），先 `sfly agent revoke-dev <名称>` 吊销它再重新运行；如果它是旧版本 `--dev` 装的开发机的名字，请管理员为它签发凭据（`sfly agent credentials issue <名称>`），再用 `--dev --name <名称>` 重新运行，凭据经环境变量 `SFLY_TOKEN` 给。
- **自己起名字**：`--dev --name <名称>` 照旧可用，这时不注册：`--token`（或 `SFLY_TOKEN`）要给管理员为这个名字签发的 Agent 凭据。
- **旧版本装的**：以前 `--dev` 默认叫 `dev-<系统用户名>-<主机名>`、用共享令牌或没有凭据。重新运行现在的 `--dev` 会向控制面注册新的开发 Agent，名字是 `dev-<登录名>-<主机>`；旧名字那一行留在 Agent 列表里（离线），场景里选了旧名字的节点要改成新的。系统用户名恰好就是登录名、主机名也没变时，新名字和旧名字相同，控制面认为它是别人留下的（你名下没有过它的凭据），注册被拒绝，见上面的「名字被占用」：换 `--dev-host`，或者请管理员为旧名字签发凭据、用 `--dev --name <旧名称>` 保留旧名字。环境里还留着 `SFLY_TOKEN`（旧版本用来传共享令牌）时，`--dev` 不给 `--name` 会直接报错：先 `unset SFLY_TOKEN`，或者同时给 `--name`。

安装脚本提示 `~/.local/bin` 不在 PATH 上时，把它加进 shell 配置（例如 `~/.bashrc`），当前终端里先执行：

```sh
export PATH="$HOME/.local/bin:$PATH"
sfly --version
```

`sfly --version` 输出 `sfly {{SFLY_VERSION}}` 即安装完成。`sfly` 记住了控制面地址（`~/.sfly/agent.env`），`sfly init`、`sfly dev`、`sfly publish` 不用再传 `--server`。控制面升级后重新运行同一条安装命令，`sfly` 就升级到控制面的版本。

## Agent 凭据

每台 Agent 用**管理员为它签发的凭据**（`sfly_agt_` 开头）连接控制面，下载节点包、上传产物也带着它。凭据**按台签发**：只对签发时指定的那个名字有效，拿到它只能冒充这一台 Agent；控制面只存哈希，原值只在签发时显示一次。同一台 Agent 可以同时有几个有效的凭据，方便轮换。

**在控制台签发**：管理员登录后，[Agent 管理](/agents) 页每台 Agent 的面板上有「凭据」按钮：列出这台 Agent 的凭据（前缀、状态、最后使用时间、所属用户，含已吊销的，不含原值），签发新的（原值只在弹窗里显示一次，弹窗里还有写好名字的安装命令和换掉已装好的 Agent 的凭据的几步）、吊销。还没连过控制面的名字用页头的「为新 Agent 签发凭据」先签发。吊销、停用的后果在确认框里写明。没有管理范围的人看不到这些按钮。命令行也能做同样的事（见下面）。

**签发要先有管理员账号**：第一次给 Agent 签发凭据之前，控制面要先有平台管理员——部署时设置 `SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD` 建第一个平台管理员，或者用初始化码在 `/setup` 页建（见「用户」）。签发、列出、吊销凭据都要管理员（项目的「管理」范围）登录，没有登录是 401。在能运行 `sfly` 的机器上（比如上面装好的开发机）登录后签发：

```sh
sfly agent credentials issue worker-1
```

输出里有凭据的原值（单独一行，只显示这一次）和装到那台机器上的命令。列出这台 Agent 的凭据（前缀、状态、最后使用时间，不含原值）：

```sh
sfly agent credentials list worker-1
```

装到测试机上时，凭据经环境变量 `SFLY_TOKEN` 传给安装命令（见上面「安装」），`--name` 写签发时的名字。要批量或远程安装、又不想让凭据经过终端屏幕和 shell 历史：用 `--token-only` 只往 stdout 写原值一行，管道交给远程机器上的 `read`（安装脚本自己的标准输入是 `curl` 送来的脚本，所以凭据由前面的 `read` 读进环境变量）：

```text
sfly agent credentials issue worker-1 --token-only | ssh worker-1 \
  'read -r SFLY_TOKEN && export SFLY_TOKEN && curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name worker-1'
```

**轮换**：先签发新的，写进那台 Agent 的 `agent.env`（`SFLY_TOKEN=<新凭据>`）并重启 Agent，确认它用新凭据连上之后，再吊销旧的（`sfly agent credentials revoke <名称> <凭据 id>`，id 在 `credentials list` 的第一列）。吊销立即生效：用它连着的连接断开，那台 Agent 手上任务的任务凭据也立刻不认。

```text
sfly agent credentials revoke worker-1 <凭据 id>
```

**从共享令牌换成 Agent 凭据**：还在用共享令牌（`SFLY_AGENT_TOKEN`）的 Agent，管理员给它签发凭据之后，**重启前要先把凭据换进 `agent.env`**（`SFLY_TOKEN`），否则重连被拒绝。一个名字在这个项目里有没吊销的 Agent 凭据，就只认凭据：共享令牌和不带凭据的连接不能再用这个名字；这个名字的凭据全部吊销之后才又接受旧方式。

**过渡期**：不带凭据的 Agent 只在本版本内被接受，而且只限默认项目里已经登记过的名字（连上过的 Agent 就是登记过的）；下一个版本起拒绝，所以现在就给每台 Agent 签发凭据。[Agent 管理](/agents) 页面能看出每台 Agent 最近一次连接用的是哪种：用共享令牌连接的写「用共享令牌连接」并提示换成 Agent 自己的凭据，没有凭据的写告警「没有凭据」，用 Agent 自己的凭据连接的什么都不写。被管理员停用的 Agent 在页面上写「已停用」和停用的时间（槽位不算空闲）；排队的任务在等一台已停用的 Agent 时，运行监控和 `sfly run show` 写「已停用」，不写「不在线」。

**Agent 被控制面拒绝时不会退出**：凭据无效或被吊销、Agent 被停用……这些改一下控制面就会好，Agent 一直重试，改好之后自己连上，不用去机器上重启。原因（不含凭据）在 Agent 的标准错误里，怎么看、间隔多长、手上的任务怎么办，见上面的「被控制面拒绝」。

## 配置与文件

所有东西都在 `~/.sfly` 下。要换成别的目录，运行安装脚本时设置环境变量 `SFLY_HOME`（systemd 服务会记住它；前台启动 Agent 和运行 `sfly` 时也要设置）：

| 位置 | 内容 |
|---|---|
| `bin/sfly-agent` | Agent 二进制 |
| `bin/uv` | Agent 管理的 uv |
| `agent.env` | 配置：每行 `KEY=VALUE`，安装脚本写入控制面地址、名称、Agent 凭据（`SFLY_TOKEN`，文件只有你读得到）、槽位数、是否自动更新、本机的镜像覆盖 |
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

[Agent 管理](/agents) 页面里每台 Agent 是一个面板：头部的「对外地址」是它的地址和端口（安装时显式配置的标明「安装时配置」），底部的「能力」一行是它支持的能力及版本。

端口被占用（或因为别的原因监听不了）时，Agent 照常连接控制面、执行任务，只是它的能力不能被其它 Agent 调用：Agent 管理页的面板头部在状态后面写「不能被其它 Agent 调用」和原因（例如「端口 50052 已被占用」）。释放端口或换一个端口后重启 Agent。不监听端口的旧版本 Agent 升级后才有能力。

验证两台 Agent 之间是通的：在另一台测试机上连这台 Agent 的地址和端口（以 Agent 管理页显示的为准），能连上说明网络和防火墙都放行了：

```text
nc -vz 10.20.30.40 50052
```

没有 `nc` 时可以用 bash：`timeout 3 bash -c '</dev/tcp/10.20.30.40/50052' && echo 通`。连不上时依次检查：Agent 管理页上这台 Agent 有没有显示「不能被其它 Agent 调用」，这台机器上 `ss -ltnp | grep 50052` 能不能看到 `sfly-agent` 在监听，两台机器之间的防火墙有没有放行这个端口，对外地址是不是另一台机器能访问到的地址。

## 版本与自动更新

Agent 和控制面必须是同一个版本。控制面升级（或回滚）后，版本不一致的 Agent 仍然保持连接，手上的任务照常跑完，但不再接新任务；[Agent 管理](/agents) 页面显示 Agent 和控制面各自的版本号和更新状态。用安装脚本安装的 Agent 自动更新到控制面的版本，面板头部的状态依次显示：

1. 「更新中 · 下载新版本」：从控制面下载同版本的 Agent，校验 sha256 并试运行。
2. 「更新中 · 等待 N 个任务结束」：等手上的任务跑完、结果都上报给控制面。
3. 「更新中 · 替换并重新启动」：替换 `bin/sfly-agent`（旧版本保留为 `bin/sfly-agent.prev`），以原来的参数重新启动，重新连上后恢复接任务。更新后的首次启动更新一次 uv。

有长任务时不必一直等：在「下载新版本」或「等待任务结束」时，Agent 管理页这台 Agent 的面板头部右侧有「立即更新」按钮。确认框列出会被终止的任务；确认后 Agent 按取消流程终止它们（任务以 `agent_lost` 失败，配置了重试的节点在更新后的 Agent 上重新执行），然后立即替换。更新失败、需要手动升级的 Agent 没有这个按钮。

下载、校验或替换失败时（下载 30 秒没有收到数据也算）显示「更新失败」和原因，Agent 继续以旧版本保持连接，下次重新连上控制面时再试。用 `sfly dev` 加载的开发版本在更新后仍然有效。

新版本连续 3 次启动失败时，Agent 恢复 `bin/sfly-agent.prev` 里的旧版本，把这个版本记为坏版本，页面上显示「更新失败」和原因。启动失败指新版本在连上控制面、准备好运行环境之前退出（读不了配置、崩溃、环境准备失败，之后被 systemd 重启），或连上控制面却握手失败，**包括被控制面拒绝**（凭据无效、Agent 被停用……：自更新在旧版本握手成功之后才开始，新版本一启动就被拒绝，多半是它自己的毛病，比如握手写错了；不算的话它永远不回滚，也收不到修好的下一个版本）；连不上控制面不算。回滚之后的旧版本再被拒绝时照旧不退出、退避重试（见「被控制面拒绝」）。试用的那几分钟里凭据恰好被吊销、Agent 恰好被停用时，这台机器上的好版本也会被记成坏版本：页面上显示「更新失败」，Agent 留在旧版本，等控制面换成其他版本再试。之后 Agent 只保持连接、不接任务，也不再自动尝试这个版本；控制面换成其他版本，或回到 Agent 现在的版本之后，会重新尝试。替换后执行新版本这一步本身就失败时，Agent 同样恢复旧版本，在日志里写出手动处理步骤并退出；用 systemd 运行时会被重新拉起，前台运行时要自己重新启动。

以下情况 Agent 不自动更新，页面上显示「需要手动升级」和原因：

- 配置了不自动更新：安装时加 `--no-auto-update`（`agent.env` 里写入 `SFLY_NO_AUTO_UPDATE=1`；也可以自己写这一行再重启 Agent，值可以是 `1`/`true`/`yes`）。需要严格控制版本的机器这样设置，升级时自己重新运行安装命令，这个设置会保留；要恢复自动更新，删掉 `agent.env` 里的这一行再重启 Agent。
- Agent 二进制不在 `$SFLY_HOME/bin`（默认 `~/.sfly/bin`）下（不是安装脚本安装的），或者这个目录不可写。

手动升级就是重新运行安装命令，名称、凭据和原来一样。

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

### 控制面的包索引：`sfly` 和 `sfly-std`

控制面自己提供一个包索引（PEP 503）`{{SFLY_URL}}/simple/`，里面只有平台自己的两个包：`sfly`（SDK 和命令行）和 `sfly-std`（[标准节点包](standard-nodes.md)的辅助函数）。它们不在 PyPI 上，所以不用往自己的 PyPI 镜像里放任何东西：

- **Agent**：连上控制面时 Welcome 带着这个索引的地址，Agent 装节点包的依赖时把它作为优先于 PyPI 镜像的索引，所以依赖 `sfly-std` 的节点包能直接装上；只要这个地址直接回答了 `sfly-std`（下面一条），`sfly-std` 就只会来自这个索引，PyPI 镜像（或上游 PyPI）上有人放了同名、版本更高的包也不会被装上；其余依赖（`psutil` 等）仍然来自 PyPI 镜像，离线环境本来就要有这个镜像。这个地址不用配置，也不能在 Agent 上覆盖：它是控制面用对外地址（`SFLY_PUBLIC_URL`）拼出的 HTTP 地址 `<对外地址>/simple/`，不是 Agent 连控制面用的 gRPC 地址。
- **开发机**：`sfly init` 生成的项目把 `sfly` 和 `sfly-std` 都指向它（见 [创建节点包项目](init-project.md)）。
- 不需要凭据，和 SDK、Agent 二进制的下载一样；索引只提供这两个包，别的名字一律 404，也不会列出任何项目里用户自己发布的节点包。
- **Agent 装依赖之前先检查这个地址**：`<对外地址>/simple/sfly-std/` 必须**直接**返回 200（不跟随重定向），**并且带控制面的标记头 `x-sfly-package-index`**（值是控制面的版本，索引的每个成功的响应都带），不满足就不装，任务以 `env_error` 失败，错误信息写明请求的地址、得到的状态码（或重定向到了哪、或「回了 200 但不是 sfly 控制面的包索引，或者中间的反向代理去掉了这个响应头」）和该检查什么。原因：uv 对一个名字只看第一个有回应的索引，这个地址回 404 或重定向到别处时它会转去 PyPI 镜像，装上那里的同名包，安装照样成功、没有任何报错；对外地址指到了一个 PyPI 风格的索引、那里恰好有同名包而回 200 时，也会装上它。控制面自己的代码不会这样回答，但对外地址指到了别的 HTTP 服务、或者反向代理把 `/simple/` 转给了别处时就会。所以**控制面的对外地址（`SFLY_PUBLIC_URL`）要指向这个控制面，反向代理要把 `/simple/` 转发给控制面**（连同路径前缀，并且不能去掉响应头）。标记头防的是配错，不是有意伪造：能控制这个地址的人本来就能直接给出假包。每次装节点包的依赖都检查，不管这个节点包有没有直接依赖 `sfly-std`（它多半是传递依赖，装之前看不出来）；检查多一次很小的请求。控制面发下这个地址的同时一定带标记头；旧版本控制面没有下发这个地址，Agent 不检查，依赖只来自 PyPI 镜像，和以前一样（只有命令行上总是写明索引策略这一点不同，见下）。
- `sfly-std` 的内容是**公共项目**里已发布的版本：平台管理员用 `POST /packages?project=public` 上传（要他本人的个人令牌，令牌从哪里来、命令行的写法见 [标准节点](standard-nodes.md#上传-sfly-std)）；不加 `project=public` 上传的在默认项目里，不会出现在这个索引里。升级时迁移进公共项目的 `sfly-std` 版本也在索引里。公共项目里还没有发布 `sfly-std` 时，依赖它的节点包装依赖时通常无解：任务以 `env_error` 失败，uv 的输出里是 `Because there are no versions of sfly-std and <节点包>==<版本> depends on sfly-std>=<要求>…`（前面是 `No solution found when resolving dependencies`）；这时先发布 `sfly-std`。（`Because sfly-std was not found in the package registry` 是另一种情形：没有控制面的包索引——旧版本控制面——而且 PyPI 镜像里也没有它。）公共项目里已有 `sfly-std` 但还没有满足要求的版本时同样无解，输出里写明要求的版本范围。
- **「只会来自这个索引」指 Agent 解析依赖的时候**：Agent 的共享环境里已经装着 `sfly-std`、并且装着的版本满足要求时，uv 保留装着的版本，不重新从索引解析。例如这台 Agent 先执行过默认项目里 `sfly-std` 自己的节点（那个节点包归档里的 wheel 被装进了共享环境），再执行依赖 `sfly-std` 的节点包，就会用已经装着的那个版本装上，不报无解。这是「一台 Agent 一个共享环境」（ADR 0012）的既有边界，不是包索引能改变的；要让它换成索引里的版本，先把共享环境里那个版本换掉：在这台 Agent 上执行一次公共项目里那个版本的 `sfly-std` 自己的节点（它的归档里的 wheel 会被装进共享环境），装上的才是索引里的那个版本；装一个别的、满足要求的版本不算。
- **不要给 Agent 的环境配 uv 的 find-links**（`UV_FIND_LINKS` 或 uv 配置文件里的 `find-links`）：那里的同名包不受「一个名字只看第一个有回应的索引」约束，会和控制面索引里的版本一起按版本比较，高版本的同名包会顶替平台自己的 `sfly-std`。Agent 不会替你去掉它们，也不检查装好的包来自哪里；只有部署者自己配置了才会出现。
- 命令行上索引参数总是写明：`uv pip install --index <控制面的包索引> --default-index <PyPI 镜像> --index-strategy first-index`（没有控制面的包索引时只有 `--default-index`，没有 PyPI 镜像时没有它）。命令行的值优先于环境变量和 uv 配置文件，所以部署者自己在环境变量或 uv 配置里换了索引策略（例如 `unsafe-best-match`）的机器，现在会被命令行盖掉；这是有意的。
- Agent 和控制面的版本不一致时，控制面不给这台 Agent 派新任务，Agent 先更新到控制面的版本（见 [版本与自动更新](#版本与自动更新)），所以下面两种组合只出现在更新的间隙里：旧版本的 Agent 不认识 Welcome 里的索引地址，照常工作，只是装不了依赖 `sfly-std` 的节点包；新版本的 Agent 连上还没有这个索引的旧控制面时，Welcome 里没有地址，Agent 只用 PyPI 镜像，和以前一样。
- 一台 Agent 的共享环境里每个包只有一个版本，`sfly-std` 也是：两个节点包对它的版本要求互相矛盾时，第二个节点包装不上，任务以 `env_error` 失败，错误信息写明是哪几个节点包、各要求什么版本（只列确实不能同时满足的要求，写法不一样但彼此相容的不列；正在装的节点包自己也算一方：它钉在自己的版本上，写成「名字@版本（正在装） 要求 名字==版本」，只有别的节点包对它的要求把这个版本排除在外时才写，不挡路的要求和与它无关的失败不写，写法带环境标记（`; python_version < "3.12"`）、写成 URL、用 `===` 或 `!=1.2.*` 的要求也不写，对第三方库的要求也一样，预发布、后发布的细则（`<2.0` 不含 `2.0` 的预发布之类）没有算进去，所以有的矛盾说明里不会列出来（少列，不会多列）（带标记或 URL 的要求，uv 的原话里通常看得到那个版本范围，看不到是哪个节点包要的；同时还有一条更严的、不带标记的要求时，uv 只写更严的那一条，带标记的那条看不到）；说明最多列 20 对，再多的写「另有 N 对没有列出」；例如锁定 `sfly-std` 0.3.0 的场景和依赖 `sfly-std>=0.4` 的节点包撞上时，说明里会写出是哪个节点包要求 `>=0.4`，见 [标准节点](standard-nodes.md) 的「从 0.3.0 升级」一节），并说明怎么办。不要按 uv 提示的 `--index-strategy unsafe-best-match` 去改：Agent 有意不用它，那会让 PyPI 上同名的包顶替平台自己的包。

### 单台机器覆盖镜像

个别机器访问不了控制面配置的镜像时（网络不同，或镜像站拒绝这台机器的请求），可以只在这台机器上换成别的镜像，不影响其他 Agent 和项目。有三个覆盖项，名字和 Agent 参数对应的环境变量相同：

| 本机覆盖 | Agent 参数 | 用途 |
|---|---|---|
| `SFLY_INDEX_URL` | `--index-url` | PyPI 镜像：Agent 安装节点包的依赖（Agent 访问 PyPI 只有这一处；平台自己的包 `sfly-std` 不走镜像，见下一节）、`--dev` 安装 `sfly` 命令行的依赖、`sfly init` 写进新项目 |
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

### 带用户名和密码的私有索引

私有的 PyPI 索引常要用户名和密码。两种配法，**推荐第一种**。

**一、凭据放在每台机器的 `~/.netrc` 里，地址不带用户名和密码（推荐）。** 控制面（`SFLY_PYPI_MIRROR`）或本机覆盖（`SFLY_INDEX_URL`）写不带凭据的地址，例如 `https://pypi.internal/simple`；在每台要访问它的机器上（测试机、开发机），运行 Agent 的那个用户的主目录里写 `~/.netrc`，权限设成 `600`：

```text
machine pypi.internal
login <用户名>
password <密码>
```

uv 会读它（先不带凭据请求一次，收到 401 之后带上凭据重试；`NETRC` 环境变量可以指到别的文件）。`install.sh --dev` 从 GitHub Release 镜像下载 uv 的安装脚本（和安装脚本里的下载）用的 curl 也读它（`machine` 写镜像的主机）：**curl 只读 `~/.netrc`，不认 `NETRC` 环境变量**（那是 uv 的），所以要给安装脚本用，凭据得写在 `~/.netrc` 里。下载 Agent 本身（从控制面下载，不要凭据）不读它。凭据只在这台机器的这个文件里：不出现在控制面的配置、`{{SFLY_URL}}/install.sh`、`sfly init` 写进新节点包的 `pyproject.toml`，也不会出现在 Agent 的日志里。

**`{{SFLY_URL}}/install.sh` 里的镜像地址不带用户名和密码**：这个脚本不用登录就能下载，控制面生成它（和 `sfly init` 读的 `/sdk/project-settings`）时把配置的镜像地址里的用户名和密码去掉，主机、端口、路径留着；`--help` 打印的也是去掉之后的。去法是按单个地址：主机那一段（到第一个 `/`、`\`、`?`、`#` 为止）里最后一个 `@` 之前的都去掉，不管用户名和密码里是什么字符；去完再检查两种读法：解析器的读法（用户名和密码必须都是空，解析不了也不行），和 curl 的读法（curl 不把 `\` 当分隔符：`://` 之后到第一个 `/`、`?`、`#` 之间不能再有 `@`——`https://CORP\jdoe:Sec7@nexus.corp/…` 解析器读不出用户名密码，curl 却读成用户名 `CORP\jdoe`、密码 `Sec7`；域账号 `域\用户名` 就是这种写法）。任何一种读法下还有用户名或密码、或者认不出写法的，这个镜像在这两处**当作没配**（`--help` 写「配了，但地址带用户名和密码，没有公开」；控制面启动时打一条警告，只写是哪个环境变量，不写地址）。所以在控制面配了带用户名和密码的镜像时，开发机（`install.sh --dev`、`sfly init`）要认证，得靠这台机器的 `~/.netrc`，或者用 `SFLY_INDEX_URL` 等环境变量设一个带凭据的地址（只对这台机器有效）。Agent 握手时拿到的仍是配置的原值，不受影响（谁拿得到见下面）。

**二、凭据写在地址里：`https://<用户名>:<密码>@pypi.internal/simple`。** uv 认这种写法；密码里的 `@`、`/`、`?`、`#`、`%` 要写成百分号编码（`@` 写成 `%40`）。控制面启动时不拒绝镜像地址里的用户名和密码（`SFLY_PUBLIC_URL`、`SFLY_PUBLIC_GRPC_URL` 才拒绝，它们要拼进链接和 Agent 的配置）。写在哪里，决定谁读得到它：

| 写在哪里 | 谁读得到 |
|---|---|
| 控制面的 `SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR` | 握手时原样下发给 Agent（**谁拿得到，见下面这一段**）。**不写进** `{{SFLY_URL}}/install.sh`（任何能访问控制面的人都下载得到）和 `sfly init` 写进新节点包 `pyproject.toml` 的配置：这两处给的是去掉了用户名和密码的地址 |
| 一台机器的 `agent.env`、环境变量（`SFLY_INDEX_URL` 等） | 这台机器上读得到 `agent.env` 的用户；这台机器上的 `sfly init` 也把它写进新节点包的 `pyproject.toml`（节点包目录进了 git 仓库，它就在仓库里） |

**握手时下发的原值，谁拿得到**：Agent 网关（gRPC）的握手把配置的原值下发给连上来的 Agent。#494 之后只给带 Agent 凭据的连接；**在那之前（过渡期）**，没有配共享令牌（`SFLY_AGENT_TOKEN`）时，连得上 Agent 网关、又知道一个按旧方式登记过的 Agent 的名字的人，也拿得到带凭据的镜像地址。所以过渡期里把带凭据的镜像配在控制面上，读者范围不止 Agent；不想这样就用第一种（凭据放各台机器的 `~/.netrc`，控制面的镜像地址不带凭据）。

用环境变量给带凭据的地址（运行安装脚本时 `SFLY_INDEX_URL=https://用户名:密码@… sh -s -- …`）也要知道：地址会出现在这条命令的 shell 历史和进程列表里，并写进 `agent.env`（只有当前用户可读）；`install.sh --dev` 也会把传进来的地址原样打到终端（安装 uv 那一行和失败时的说明）。

所以要用第二种时，让凭据的读者范围尽量小：控制面配的只下发给 Agent（握手时，过渡期的限度见上），开发机上要认证就配在那台机器上。

**Agent 的日志里没有这些用户名和密码**：Agent 写进安装日志（任务的安装状态）、任务的失败原因、环境准备失败的报告和日志的地址，用户名和密码一律换成 `***`，主机、端口和路径留着，方便看出连的是哪：`https://***@pypi.internal/simple`。命令行、uv 和 curl 的输出里回显的地址、报错里的地址都一样。做法分两层（#757）：**Agent 自己知道的地址**（`--server`、本机覆盖的三个镜像、控制面握手时下发的镜像和下载地址）先按整个地址换掉，不管用户名和密码里是什么字符（空白、`"`、反引号、`<`、`>` 都认，URL 解析器和 uv 接受它们）；日志里别的地址（uv 打印的、重定向到的）再按「`://` 之后到第一个 `/`、`?`、`#`、空白、引号为止，最后一个 `@` 之前」的文字规则兜底。用户名或密码里有 `\`（AD 风格的 `域\用户名`）的地址，URL 解析器和 curl 读出的凭据不一样，认不准凭据在哪，**整个地址不写出来**，日志里是 `***`。限度：只认「地址里的 `用户名:密码@`」这个形状；没有登记过的地址只靠文字规则，凭据里有空白、引号、反引号、`<`、`>`、`\` 时它认不出；`UV_INDEX_*_PASSWORD` 这类环境变量的值、`~/.netrc` 里的凭据不在地址里，Agent 不读也不打印它们，但节点自己的输出里有什么 Agent 管不到。控制面读日志时的打码只认平台自己签发的令牌和场景的 secret 参数的值，**不认地址里的密码**，所以不要指望它兜底。

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
