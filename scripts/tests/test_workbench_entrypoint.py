"""工作台容器的入口脚本（deploy/workbench/entrypoint.sh，#549）。

用一个假的 curl（把「控制面的 install.sh」写到 -o 的位置）和一份假的安装脚本
（建出 Agent、agent.env、sfly 命令行，把自己收到的参数和环境记下来）在临时的家目录和工作区里
运行入口脚本，不需要 Docker。检查：

- 家目录里没有 Agent：下载控制面的安装脚本，以 `--dev --name … --public-address … --no-service`
  运行，凭据经环境变量交给它、不在参数里；然后前台启动 Agent，Agent 的环境里是 SFLY_TOKEN、
  没有入口自己的 SFLY_WORKBENCH_TOKEN；
- 已经装好（安装标记、Agent、agent.env、sfly 都在）：不下载、不重装，直接启动；
- 上次装到一半被打断（没有标记、缺文件、留着临时文件）：重装，临时文件清掉；换了名字也重装；
- 安装失败：非零退出，不留标记，不启动 Agent；
- 缺变量、卷写不了：非零退出，说清楚缺什么、怎么改；
- 装好之后每次启动对一下控制面的 install.sh：sha256 变了就重装，没变不重装，
  取不到照常启动（短超时、不重试）；
- 入口脚本自己用的命令只在系统目录里找：家目录的 ~/.local/bin 里放了假的 cat、curl、sh……
  也不执行，Agent 的 PATH 里它在最后；
- 凭据不出现在入口脚本的输出里；
- compose 里（SFLY_WORKBENCH_REQUIRE_FIREWALL=1）出网名单的规则写好之前（127.0.0.1:47123 不应答）
  不下载、不安装、不启动 Agent，一直等。
真实的镜像、卷和控制面由 scripts/release/workbench-image-smoke.sh 检查。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "deploy" / "workbench" / "entrypoint.sh"
TOKEN = "sfly_agt_" + "a1b2c3d4e5f6" * 4
NAME = "workbench"

# 假的 curl：记下参数，把 $FAKE_INSTALL_SH 复制到 -o 指的文件
# （FAKE_CURL_FAIL 设置时像连不上控制面一样失败）；问出网名单就绪的，
# $FAKE_LOG/firewall.ready 在才成功（FAKE_REAL_CURL 设置时交给真的 curl）。
FAKE_CURL = """#!/bin/sh
echo "$*" >> "$FAKE_LOG/curl.args"
case "$*" in
*127.0.0.1:47123*)
	[ -z "${FAKE_REAL_CURL:-}" ] || exec "$FAKE_REAL_CURL" "$@"
	[ -e "$FAKE_LOG/firewall.ready" ] && exit 0 || exit 7 ;;
esac
[ -z "${FAKE_CURL_FAIL:-}" ] || exit 7
out=
while [ $# -gt 0 ]; do
	[ "$1" != -o ] || out=$2
	shift
done
cp "$FAKE_INSTALL_SH" "$out"
"""

# 假的 install.sh：记下参数和环境；装出 Agent（运行时把自己的环境记下来）、agent.env 和
# sfly 命令行。
FAKE_INSTALL = """#!/bin/sh
echo "$*" > "$FAKE_LOG/install.args"
env > "$FAKE_LOG/install.env"
echo run >> "$FAKE_LOG/install.runs"
if [ -n "${FAKE_INSTALL_FAIL:-}" ]; then
	# wipe：失败之前已经把装好的 Agent 二进制换没了（装到一半）。
	[ "$FAKE_INSTALL_FAIL" != wipe ] || rm -f "$SFLY_HOME/bin/sfly-agent"
	echo "install.sh: 下载失败" >&2
	exit 1
fi
mkdir -p "$SFLY_HOME/bin" "$HOME/.local/bin"
cat > "$SFLY_HOME/bin/sfly-agent" <<'AGENT'
#!/bin/sh
env > "$FAKE_LOG/agent.env.dump"
echo "agent" >> "$FAKE_LOG/agent.runs"
AGENT
chmod +x "$SFLY_HOME/bin/sfly-agent"
printf 'SFLY_AGENT_NAME=%s\\n' "$3" > "$SFLY_HOME/agent.env"
printf '#!/bin/sh\\n' > "$HOME/.local/bin/sfly"
chmod +x "$HOME/.local/bin/sfly"
"""


class Harness:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.home = root / "home"
        self.work = root / "work"
        self.log = root / "log"
        bin_dir = root / "bin"
        for directory in (self.home, self.work, self.log, bin_dir):
            directory.mkdir()
        (bin_dir / "curl").write_text(FAKE_CURL)
        (bin_dir / "curl").chmod(0o755)
        (root / "install.sh").write_text(FAKE_INSTALL)
        # 入口脚本自己用的 PATH（SFLY_WORKBENCH_BASE_PATH）：假 curl 所在的目录加系统目录。
        self.path = f"{bin_dir}:/usr/bin:/bin:/usr/sbin:/sbin"

    @property
    def sfly_home(self) -> Path:
        return self.home / ".sfly"

    def run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/sh", str(ENTRYPOINT)],
            env=self.env(overrides),
            capture_output=True,
            text=True,
            timeout=60,
        )

    def start(self, **overrides: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            ["/bin/sh", str(ENTRYPOINT)],
            env=self.env(overrides),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def env(self, overrides: dict[str, str]) -> dict[str, str]:
        env = {
            # 容器里的 PATH：~/.local/bin 在最前（Dockerfile 里原来的写法，现在入口脚本不看它）。
            "PATH": f"{self.home}/.local/bin:{self.path}",
            "SFLY_WORKBENCH_BASE_PATH": self.path,
            "HOME": str(self.home),
            "FAKE_LOG": str(self.log),
            "FAKE_INSTALL_SH": str(self.root / "install.sh"),
            "SFLY_WORKBENCH_URL": "http://sfly:8080",
            "SFLY_WORKBENCH_NAME": NAME,
            "SFLY_WORKBENCH_PUBLIC_ADDRESS": "sfly-workbench",
            "SFLY_WORKBENCH_TOKEN": TOKEN,
            "SFLY_WORKBENCH_WORK": str(self.work),
        }
        env.update(overrides)
        return {key: value for key, value in env.items() if value != "<unset>"}

    def change_install_script(self, note: str) -> None:
        """控制面的 install.sh 变了（升级、改了对外地址）：内容不一样。"""
        with (self.root / "install.sh").open("a") as file:
            file.write(f"# {note}\n")

    def plant(self, tools: list[str]) -> None:
        """家目录的 ~/.local/bin 里放假的命令：被执行就记一行到 planted.runs。"""
        directory = self.home / ".local" / "bin"
        directory.mkdir(parents=True, exist_ok=True)
        for tool in tools:
            script = directory / tool
            script.write_text(f'#!/bin/sh\necho {tool} >> "$FAKE_LOG/planted.runs"\nexit 0\n')
            script.chmod(0o755)

    def marker(self) -> dict[str, str]:
        text = (self.sfly_home / ".workbench-installed").read_text()
        return dict(line.split("=", 1) for line in text.splitlines())

    def lines(self, name: str) -> list[str]:
        path = self.log / name
        return path.read_text().splitlines() if path.exists() else []

    def agent_environment(self) -> dict[str, str]:
        pairs = (line.split("=", 1) for line in self.lines("agent.env.dump") if "=" in line)
        return {key: value for key, value in pairs}


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def test_a_fresh_volume_installs_the_agent_the_dev_way_and_starts_it(harness: Harness) -> None:
    result = harness.run()

    assert result.returncode == 0, result.stderr
    # 从控制面（服务名）下载安装脚本。
    assert "http://sfly:8080/install.sh" in harness.lines("curl.args")[0]
    # 按 --dev 方式装：名字、对外地址（服务名）、不注册服务。
    assert harness.lines("install.args") == [
        f"--dev --name {NAME} --public-address sfly-workbench --no-service"
    ]
    # 装完写下标记（名字、安装的那份 install.sh 的 sha256），然后前台启动 Agent。
    assert harness.marker() == {
        "name": NAME,
        "install_sh_sha256": hashlib.sha256((harness.root / "install.sh").read_bytes()).hexdigest(),
    }
    assert harness.lines("agent.runs") == ["agent"]
    # curl 不读家目录里的 .curlrc（模型写得了）：-q 是第一个参数。
    assert all(line.startswith("-q ") for line in harness.lines("curl.args"))


def test_with_the_firewall_required_nothing_runs_until_its_rules_are_ready(
    harness: Harness,
) -> None:
    # 宿主机重启时 Docker 直接恢复两个容器，不等 compose 的健康检查：工作台可能比规则先起。
    process = harness.start(SFLY_WORKBENCH_REQUIRE_FIREWALL="1")
    try:
        deadline = time.monotonic() + 30
        while len(harness.lines("curl.args")) < 3:
            assert process.poll() is None, process.communicate()
            assert time.monotonic() < deadline
            time.sleep(0.1)
        # 一直在问就绪端口；没有下载 install.sh、没有安装、没有启动 Agent。
        assert all("http://127.0.0.1:47123/" in line for line in harness.lines("curl.args"))
        assert harness.lines("install.runs") == [] and harness.lines("agent.runs") == []

        (harness.log / "firewall.ready").touch()
        stdout, stderr = process.communicate(timeout=30)
    finally:
        process.kill()
    assert process.returncode == 0, stderr
    calls = harness.lines("curl.args")
    ready = max(i for i, line in enumerate(calls) if "127.0.0.1:47123" in line)
    assert "http://sfly:8080/install.sh" in calls[ready + 1]
    assert harness.lines("agent.runs") == ["agent"]
    assert stdout.index("出网名单的规则已写好") < stdout.index("下载安装脚本")
    assert TOKEN not in stdout + stderr


class Answer(BaseHTTPRequestHandler):
    """什么请求都回 200，记下收到的请求行。"""

    seen: list[str]

    def do_GET(self) -> None:
        self.seen.append(self.requestline)
        self.send_response(200)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


def answering(port: int) -> tuple[HTTPServer, list[str]]:
    seen: list[str] = []
    handler = type("Handler", (Answer,), {"seen": seen})
    server = HTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def test_a_proxy_in_the_environment_cannot_answer_for_the_firewall(harness: Harness) -> None:
    # 部署者可能给工作台设了代理变量（装包用）：会回 200 的代理不能替出网名单应答就绪。
    proxy, proxied = answering(0)
    address = f"http://127.0.0.1:{proxy.server_address[1]}"
    variables = ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY")
    process = harness.start(
        SFLY_WORKBENCH_REQUIRE_FIREWALL="1",
        FAKE_REAL_CURL=shutil.which("curl") or "curl",
        **dict.fromkeys(variables, address),
    )
    ready: HTTPServer | None = None
    try:
        deadline = time.monotonic() + 30
        while len(harness.lines("curl.args")) < 3:
            assert process.poll() is None, process.communicate()
            assert time.monotonic() < deadline
            time.sleep(0.1)
        assert harness.lines("install.runs") == [] and harness.lines("agent.runs") == []

        ready, answered = answering(47123)
        stdout, stderr = process.communicate(timeout=30)
    finally:
        process.kill()
        proxy.shutdown()
        if ready is not None:
            ready.shutdown()
            ready.server_close()
    assert process.returncode == 0, stderr
    assert proxied == [], "就绪请求走了代理"
    assert answered and harness.lines("agent.runs") == ["agent"]
    assert stdout.index("出网名单的规则已写好") < stdout.index("下载安装脚本")


def test_without_the_firewall_requirement_the_entrypoint_does_not_wait(harness: Harness) -> None:
    # 镜像冒烟、评测的被测机等不经 compose 出网名单的用法：不设这个变量，不等。
    result = harness.run()
    assert result.returncode == 0, result.stderr
    assert not any("47123" in line for line in harness.lines("curl.args"))


def test_the_credential_goes_to_the_installer_and_the_agent_by_environment_only(
    harness: Harness,
) -> None:
    result = harness.run()

    assert result.returncode == 0, result.stderr
    # 不在任何命令行参数里（curl 和安装脚本的参数都没有），也不在入口脚本的输出里。
    for name in ("curl.args", "install.args"):
        assert TOKEN not in "\n".join(harness.lines(name))
    assert TOKEN not in result.stdout + result.stderr
    # 安装脚本和 Agent 都从环境变量 SFLY_TOKEN 拿到它。
    install_env = dict(line.split("=", 1) for line in harness.lines("install.env") if "=" in line)
    assert install_env["SFLY_TOKEN"] == TOKEN
    agent_env = harness.agent_environment()
    assert agent_env["SFLY_TOKEN"] == TOKEN
    assert agent_env["SFLY_HOME"] == str(harness.sfly_home)
    # 入口自己的变量从环境里去掉了：Agent 起的命令继承的环境里不会有它（Agent 只去掉 SFLY_TOKEN）。
    assert "SFLY_WORKBENCH_TOKEN" not in agent_env
    assert "SFLY_WORKBENCH_TOKEN" not in install_env


def test_a_shared_token_in_the_container_environment_is_never_used(harness: Harness) -> None:
    # 工作台的安装命令里没有共享令牌（#549）：容器环境里就算有共享令牌（SFLY_AGENT_TOKEN）或别的
    # SFLY_TOKEN，安装脚本和 Agent 的 `SFLY_TOKEN` 也只是 SFLY_WORKBENCH_TOKEN 交进来的那枚
    # Agent 凭据，共享令牌不出现在参数和输出里（compose 不把共享令牌传给工作台，见
    # test_deploy_compose.py；这里是入口脚本自己不去用它）。
    shared = "shared-agent-token-value-0123456789"
    result = harness.run(SFLY_AGENT_TOKEN=shared, SFLY_TOKEN=shared)

    assert result.returncode == 0, result.stderr
    for name in ("curl.args", "install.args"):
        assert shared not in "\n".join(harness.lines(name))
    assert shared not in result.stdout + result.stderr
    install_env = dict(line.split("=", 1) for line in harness.lines("install.env") if "=" in line)
    assert install_env["SFLY_TOKEN"] == TOKEN
    assert harness.agent_environment()["SFLY_TOKEN"] == TOKEN
    # 入口脚本不看 SFLY_AGENT_TOKEN，也不拿它当 --token。
    assert "--token" not in " ".join(harness.lines("install.args"))


def test_an_installed_volume_with_an_unchanged_install_script_starts_without_reinstalling(
    harness: Harness,
) -> None:
    assert harness.run().returncode == 0
    asked = len(harness.lines("curl.args"))

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert "已经装好，直接启动" in result.stdout
    assert "install.sh 没变" in result.stdout
    # 只问了一次 install.sh（短超时，不重试），没有重新运行安装脚本。
    assert len(harness.lines("curl.args")) == asked + 1
    check = harness.lines("curl.args")[-1]
    assert "--max-time 5" in check and "--retry" not in check
    # 问 install.sh 的那一次也不读 .curlrc。
    assert all(line.startswith("-q ") for line in harness.lines("curl.args"))
    assert harness.lines("install.runs") == ["run"]
    assert harness.lines("agent.runs") == ["agent", "agent"]
    # 重建容器之后也用环境里的凭据（换了凭据只要改 .env、重建容器）。
    new_token = "sfly_agt_" + "f" * 48
    assert harness.run(SFLY_WORKBENCH_TOKEN=new_token).returncode == 0
    assert harness.agent_environment()["SFLY_TOKEN"] == new_token


def test_a_changed_install_script_installs_again_and_then_stays_quiet(harness: Harness) -> None:
    # 控制面升级、改了 SFLY_PUBLIC_URL 或镜像之后，它的 install.sh 内容变了：
    # 工作台重装（sfly 命令行不会自己升级）。
    assert harness.run().returncode == 0
    harness.change_install_script("控制面升级了")

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert "install.sh 变了" in result.stdout
    assert harness.lines("install.runs") == ["run", "run"]
    assert (
        harness.marker()["install_sh_sha256"]
        == hashlib.sha256((harness.root / "install.sh").read_bytes()).hexdigest()
    )
    assert harness.lines("agent.runs") == ["agent", "agent"]
    # 重装用的就是刚取到的那份：curl 一共两次（第一次启动一次、这次一次），没有为重装再下载。
    assert len(harness.lines("curl.args")) == 2
    # 之后没变就不再重装，每次启动只问一次。
    assert harness.run().returncode == 0
    assert harness.lines("install.runs") == ["run", "run"]
    assert harness.lines("agent.runs") == ["agent", "agent", "agent"]
    assert len(harness.lines("curl.args")) == 3


def test_a_failed_reinstall_does_not_stop_the_installed_agent_and_is_tried_again(
    harness: Harness,
) -> None:
    # 升级时镜像暂时不通、离线缓存缺新版命令行的依赖、切到要认证的镜像还没挂 .netrc：重装失败。
    # Agent 本身好好的，过期的只是 sfly 命令行：不能让容器起不来、一直重启。
    assert harness.run().returncode == 0
    old_marker = harness.marker()
    harness.change_install_script("控制面升级了")

    result = harness.run(FAKE_INSTALL_FAIL="1")

    assert result.returncode == 0, result.stderr
    assert "install.sh 变了" in result.stdout
    assert "安装脚本失败" in result.stderr
    assert "重新安装没有成功" in result.stderr
    assert TOKEN not in result.stdout + result.stderr
    assert harness.lines("install.runs") == ["run", "run"]
    # 已经装好的 Agent 照常启动，标记不动（还是旧的 sha256：下次启动再试）。
    assert harness.lines("agent.runs") == ["agent", "agent"]
    assert harness.marker() == old_marker
    assert harness.agent_environment()["SFLY_TOKEN"] == TOKEN

    # 之后装得上了：重装、记新的 sha256。
    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert harness.lines("install.runs") == ["run", "run", "run"]
    assert harness.marker()["install_sh_sha256"] != old_marker["install_sh_sha256"]
    assert (
        harness.marker()["install_sh_sha256"]
        == hashlib.sha256((harness.root / "install.sh").read_bytes()).hexdigest()
    )
    assert harness.lines("agent.runs") == ["agent", "agent", "agent"]


def test_a_failed_reinstall_that_took_the_agent_away_stops_the_container(harness: Harness) -> None:
    # 重装失败，而且已有的 Agent 二进制已经被换没了：没有可以启动的，才退出，并说明原因。
    assert harness.run().returncode == 0
    harness.change_install_script("控制面升级了")

    result = harness.run(FAKE_INSTALL_FAIL="wipe")

    assert result.returncode != 0
    assert "没有可以启动的 Agent" in result.stderr
    assert harness.lines("agent.runs") == ["agent"]


def test_a_marker_without_the_install_script_hash_installs_again_once(harness: Harness) -> None:
    assert harness.run().returncode == 0
    (harness.sfly_home / ".workbench-installed").write_text(f"name={NAME}\n")

    assert harness.run().returncode == 0
    assert harness.lines("install.runs") == ["run", "run"]
    assert "install_sh_sha256" in harness.marker()
    assert harness.run().returncode == 0
    assert harness.lines("install.runs") == ["run", "run"]


def test_an_installed_volume_starts_when_the_control_plane_is_unreachable(harness: Harness) -> None:
    assert harness.run().returncode == 0

    harness.change_install_script("就算控制面的脚本变了，取不到时也不重装")
    result = harness.run(FAKE_CURL_FAIL="1")

    assert result.returncode == 0, result.stderr
    assert "取不到" in result.stdout
    assert harness.lines("install.runs") == ["run"]
    assert harness.lines("agent.runs") == ["agent", "agent"]
    # 短超时、不重试：控制面不通时不让已经装好的 Agent 等很久。
    assert "--retry" not in harness.lines("curl.args")[-1]


@pytest.mark.parametrize(
    "damage",
    [
        "no-marker",
        "no-sfly-cli",
        "no-agent-binary",
        "no-agent-env",
    ],
)
def test_a_half_installed_volume_is_installed_again(harness: Harness, damage: str) -> None:
    assert harness.run().returncode == 0
    removed = {
        "no-marker": harness.sfly_home / ".workbench-installed",
        "no-sfly-cli": harness.home / ".local" / "bin" / "sfly",
        "no-agent-binary": harness.sfly_home / "bin" / "sfly-agent",
        "no-agent-env": harness.sfly_home / "agent.env",
    }[damage]
    removed.unlink()

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert harness.lines("install.runs") == ["run", "run"]
    assert (harness.sfly_home / ".workbench-installed").exists()
    assert removed.exists()
    assert harness.lines("agent.runs") == ["agent", "agent"]


def test_leftovers_of_an_interrupted_install_are_cleaned_before_installing_again(
    harness: Harness,
) -> None:
    bin_dir = harness.sfly_home / "bin"
    bin_dir.mkdir(parents=True)
    leftovers = [
        bin_dir / ".sfly-agent.download.4242",
        bin_dir / ".uv-installer.4242.sh",
        bin_dir / ".user-agent.4242" / ".curlrc",
        harness.sfly_home / "agent.env.tmp",
    ]
    for leftover in leftovers:
        leftover.parent.mkdir(parents=True, exist_ok=True)
        leftover.write_text("half")

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert not any(leftover.exists() for leftover in leftovers)
    assert harness.lines("install.runs") == ["run"]


def test_a_different_name_is_installed_again(harness: Harness) -> None:
    assert harness.run().returncode == 0

    result = harness.run(SFLY_WORKBENCH_NAME="workbench-2")

    assert result.returncode == 0, result.stderr
    assert harness.lines("install.runs") == ["run", "run"]
    assert "--name workbench-2" in harness.lines("install.args")[0]
    assert harness.marker()["name"] == "workbench-2"


def test_a_failed_install_leaves_no_marker_and_does_not_start_the_agent(harness: Harness) -> None:
    result = harness.run(FAKE_INSTALL_FAIL="1")

    assert result.returncode != 0
    assert "安装脚本失败" in result.stderr
    assert TOKEN not in result.stdout + result.stderr
    assert not (harness.sfly_home / ".workbench-installed").exists()
    assert harness.lines("agent.runs") == []
    # 之后装得上了，就装好、启动。
    assert harness.run().returncode == 0
    assert harness.lines("agent.runs") == ["agent"]


def test_an_unreachable_control_plane_stops_before_installing(harness: Harness) -> None:
    result = harness.run(FAKE_CURL_FAIL="1")

    assert result.returncode != 0
    assert "下载 http://sfly:8080/install.sh 失败" in result.stderr
    assert harness.lines("install.runs") == []
    assert not (harness.sfly_home / ".workbench-installed").exists()


PLANTED = ["cat", "curl", "sed", "head", "cut", "sh", "sha256sum", "mktemp", "rm", "id", "printf"]


@pytest.mark.parametrize("state", ["fresh", "installed", "changed"])
def test_commands_in_the_home_volume_are_not_run_by_the_entrypoint(
    harness: Harness, state: str
) -> None:
    # 家目录是卷，工作台上的模型写得了 ~/.local/bin（容器环境的 PATH 里它在最前面）：
    # 入口脚本自己用的命令只在系统目录里找，否则模型放一个假的 cat、curl，
    # 入口脚本下次启动就执行它，而这时手上有刚交进来的凭据。
    if state != "fresh":
        assert harness.run().returncode == 0
    harness.plant(PLANTED)
    if state == "changed":
        harness.change_install_script("控制面升级了")

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert harness.lines("planted.runs") == [], "入口脚本执行了家目录里放的命令"
    # 装好的 Agent 看到的 PATH：系统目录在前，~/.local/bin 加在最后
    # （sfly、uv 在那里，盖不掉系统的命令）。
    path = harness.agent_environment()["PATH"]
    assert path == f"{harness.path}:{harness.home}/.local/bin"


@pytest.mark.parametrize(
    ("variable", "mentioned"),
    [
        ("SFLY_WORKBENCH_URL", "SFLY_WORKBENCH_URL"),
        ("SFLY_WORKBENCH_NAME", "SFLY_WORKBENCH_NAME"),
        ("SFLY_WORKBENCH_PUBLIC_ADDRESS", "SFLY_WORKBENCH_PUBLIC_ADDRESS"),
        ("SFLY_WORKBENCH_TOKEN", "SFLY_WORKBENCH_TOKEN"),
    ],
)
def test_a_missing_variable_stops_the_container_and_says_which_one(
    harness: Harness, variable: str, mentioned: str
) -> None:
    result = harness.run(**{variable: ""})

    assert result.returncode != 0
    assert mentioned in result.stderr
    assert harness.lines("curl.args") == []
    assert harness.lines("agent.runs") == []


def test_the_missing_credential_message_says_how_to_issue_one(harness: Harness) -> None:
    result = harness.run(SFLY_WORKBENCH_TOKEN="")

    assert f"sfly api POST /projects/default/agents/{NAME}/credentials" in result.stderr


@pytest.mark.skipif(os.geteuid() == 0, reason="root 写得了任何目录")
@pytest.mark.parametrize("volume", ["home", "work"])
def test_a_volume_the_user_cannot_write_stops_the_container_and_says_how_to_fix_it(
    harness: Harness, volume: str
) -> None:
    directory = harness.home if volume == "home" else harness.work
    directory.chmod(0o500)
    try:
        result = harness.run()
    finally:
        directory.chmod(0o700)

    assert result.returncode != 0
    assert str(directory) in result.stderr
    assert f"chown -R {os.getuid()}:{os.getgid()}" in result.stderr
    assert harness.lines("curl.args") == []
