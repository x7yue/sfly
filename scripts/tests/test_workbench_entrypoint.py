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
- 凭据不出现在入口脚本的输出里。
真实的镜像、卷和控制面由 scripts/release/workbench-image-smoke.sh 检查。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "deploy" / "workbench" / "entrypoint.sh"
TOKEN = "sfly_agt_" + "a1b2c3d4e5f6" * 4
NAME = "workbench"

# 假的 curl：记下参数，把 $FAKE_INSTALL_SH 复制到 -o 指的文件
# （FAKE_CURL_FAIL 设置时像连不上控制面一样失败）。
FAKE_CURL = """#!/bin/sh
echo "$*" >> "$FAKE_LOG/curl.args"
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
        self.path = f"{bin_dir}:/usr/bin:/bin"

    @property
    def sfly_home(self) -> Path:
        return self.home / ".sfly"

    def run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        env = {
            "PATH": self.path,
            "HOME": str(self.home),
            "FAKE_LOG": str(self.log),
            "FAKE_INSTALL_SH": str(self.root / "install.sh"),
            "SFLY_WORKBENCH_URL": "http://sfly:8080",
            "SFLY_WORKBENCH_AGENT": NAME,
            "SFLY_WORKBENCH_PUBLIC_ADDRESS": "sfly-workbench",
            "SFLY_WORKBENCH_TOKEN": TOKEN,
            "SFLY_WORKBENCH_WORK": str(self.work),
        }
        env.update(overrides)
        env = {key: value for key, value in env.items() if value != "<unset>"}
        return subprocess.run(
            ["sh", str(ENTRYPOINT)], env=env, capture_output=True, text=True, timeout=60
        )

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
    # 装完写下标记，然后前台启动 Agent。
    assert (harness.sfly_home / ".workbench-installed").read_text() == f"name={NAME}\n"
    assert harness.lines("agent.runs") == ["agent"]


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


def test_an_installed_volume_starts_the_agent_without_downloading_or_reinstalling(
    harness: Harness,
) -> None:
    assert harness.run().returncode == 0
    downloads = len(harness.lines("curl.args"))

    result = harness.run()

    assert result.returncode == 0, result.stderr
    assert "已经装好，直接启动" in result.stdout
    assert len(harness.lines("curl.args")) == downloads
    assert harness.lines("install.runs") == ["run"]
    assert harness.lines("agent.runs") == ["agent", "agent"]
    # 重建容器之后也用环境里的凭据（换了凭据只要改 .env、重建容器）。
    new_token = "sfly_agt_" + "f" * 48
    assert harness.run(SFLY_WORKBENCH_TOKEN=new_token).returncode == 0
    assert harness.agent_environment()["SFLY_TOKEN"] == new_token


def test_an_installed_volume_starts_when_the_control_plane_is_unreachable(harness: Harness) -> None:
    assert harness.run().returncode == 0

    result = harness.run(FAKE_CURL_FAIL="1")

    assert result.returncode == 0, result.stderr
    assert harness.lines("agent.runs") == ["agent", "agent"]


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

    result = harness.run(SFLY_WORKBENCH_AGENT="workbench-2")

    assert result.returncode == 0, result.stderr
    assert harness.lines("install.runs") == ["run", "run"]
    assert "--name workbench-2" in harness.lines("install.args")[0]
    assert (harness.sfly_home / ".workbench-installed").read_text() == "name=workbench-2\n"


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


@pytest.mark.parametrize(
    ("variable", "mentioned"),
    [
        ("SFLY_WORKBENCH_URL", "SFLY_WORKBENCH_URL"),
        ("SFLY_WORKBENCH_AGENT", "SFLY_WORKBENCH_AGENT"),
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

    assert f"sfly api POST /agents/{NAME}/credentials" in result.stderr


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
