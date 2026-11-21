"""`pnpm heavy --pg`（scripts/heavy.sh）不在 Docker 里留下卷（#525）。

postgres 镜像声明了数据目录的卷，容器启动时 Docker 会为它建一个匿名卷。
`docker rm -f` 不带 `-v` 删容器时这个卷留下：每跑一次 `pnpm heavy --pg` 就多一个
没有容器引用的卷（每个 50 到 80 MB），两天攒了 412 个、33 GB，把开发机的磁盘写满。

这里不数「没有容器引用的卷」的总数：开发机上别的代理同时在跑 docker，总数会自己变。
改为盯着这一次运行自己的容器挂着的卷，运行结束（正常结束、被 Ctrl-C 中断、
被 SIGKILL 杀掉之后跑 `--clean`）之后，这几个卷必须没有了。
脚本复制到临时目录里换个工作区名再跑：它的容器标签是独有的，
`--clean` 只会删这一次测试起的容器，不碰别人的。

没有 docker 时本地跳过；CI（设置了 CI）上必须有 docker，没有就失败，不能悄悄不测。"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PG_IMAGE = "postgres:18"
READY = "这次运行的 PostgreSQL 在"
# 第一次要拉镜像：CI 上的 runner 是干净的。
STARTUP_SECONDS = 240


def _docker(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


def _docker_usable() -> bool:
    if shutil.which("docker") is None:
        return False
    return _docker("info").returncode == 0


@pytest.fixture(scope="module", autouse=True)
def docker_required() -> None:
    if _docker_usable():
        return
    if os.environ.get("CI"):
        pytest.fail("CI 上必须有 docker：这个测试守着 pnpm heavy --pg 不留卷，不能悄悄跳过")
    pytest.skip("没有可用的 docker")


@pytest.fixture(scope="module", autouse=True)
def image_declares_a_volume(docker_required: None) -> None:
    """前提：postgres 镜像声明了数据卷，否则没有可漏的东西，下面的检查就什么也证明不了。"""
    _docker("pull", "--quiet", PG_IMAGE)
    declared = _docker("image", "inspect", "--format", "{{json .Config.Volumes}}", PG_IMAGE)
    assert declared.returncode == 0, declared.stderr
    if declared.stdout.strip() in ("", "null", "{}"):
        pytest.skip(f"{PG_IMAGE} 不再声明数据卷，没有可漏的卷")


@dataclass
class Workspace:
    """脚本的一份副本：工作区名（也是容器标签的一部分）只属于这一次测试。"""

    name: str
    script: Path
    tmp_root: Path
    volumes: set[str]

    @property
    def label(self) -> str:
        return f"sfly-heavy-pg={self.name}"

    def env(self) -> dict[str, str]:
        # 不继承外层 pnpm heavy 的状态：外层设置的 SFLY_HEAVY_OWNER 会让这里的脚本当成嵌套运行。
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith("SFLY_HEAVY_") and k != "DATABASE_URL"
        }
        env["SFLY_HEAVY_LOCK"] = "none"
        env["SFLY_HEAVY_TMP_ROOT"] = str(self.tmp_root)
        return env

    def containers(self) -> list[str]:
        out = _docker("ps", "-a", "--filter", f"label={self.label}", "--format", "{{.Names}}")
        return out.stdout.split()

    def volumes_of(self, container: str) -> set[str]:
        out = _docker(
            "inspect",
            "--format",
            '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
            container,
        )
        found = set(out.stdout.split()) if out.returncode == 0 else set()
        self.volumes |= found
        return found

    def leftover_volumes(self) -> list[str]:
        return [v for v in sorted(self.volumes) if _docker("volume", "inspect", v).returncode == 0]

    def start(self, *command: str) -> tuple[subprocess.Popen[bytes], Path, str]:
        """起 `heavy.sh --pg -- <命令>`，等到数据库就绪；返回进程、它的 stderr 文件和容器名。

        进程放进自己的会话（进程组）里：之后能像终端的 Ctrl-C 那样把信号发给整个前台进程组。
        """
        stderr_file = self.tmp_root / f"stderr-{uuid.uuid4().hex[:6]}.log"
        stderr = stderr_file.open("wb")
        proc = subprocess.Popen(
            ["bash", str(self.script), "--pg", "--", *command],
            env=self.env(),
            stdout=subprocess.DEVNULL,
            stderr=stderr,
            start_new_session=True,
            # 外层可能是后台作业，SIGINT 被设成忽略；被忽略的信号在 bash 里设不了 trap，
            # 所以这里恢复默认。
            preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
        )
        container = f"sfly-heavy-pg-{self.name}-{proc.pid}"
        deadline = time.monotonic() + STARTUP_SECONDS
        while time.monotonic() < deadline:
            if READY in stderr_file.read_text(errors="ignore"):
                self.volumes_of(container)
                return proc, stderr_file, container
            if proc.poll() is not None:
                break
            time.sleep(0.3)
        proc.kill()
        pytest.fail(f"数据库没有就绪：\n{stderr_file.read_text(errors='ignore')}")


@pytest.fixture
def ws(tmp_path: Path) -> Iterator[Workspace]:
    name = f"sfly-heavy-vol-{uuid.uuid4().hex[:8]}"
    root = tmp_path / name
    (root / "scripts").mkdir(parents=True)
    script = root / "scripts" / "heavy.sh"
    shutil.copy(ROOT / "scripts" / "heavy.sh", script)
    workspace = Workspace(name, script, tmp_path / "t", set())
    workspace.tmp_root.mkdir()
    yield workspace
    # 测试失败时也不留东西：只删这一次测试自己的容器和它们的卷。
    for container in workspace.containers():
        workspace.volumes_of(container)
        _docker("rm", "-f", "-v", container)
    for volume in workspace.leftover_volumes():
        _docker("volume", "rm", "-f", volume)


def test_a_finished_run_leaves_no_volume(ws: Workspace) -> None:
    """命令正常结束：容器连同它的匿名卷一起删掉。"""
    seen = ws.tmp_root / "volumes.txt"
    command = (
        "docker inspect --format "
        "'{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}' "
        f'"sfly-heavy-pg-{ws.name}-$SFLY_HEAVY_OWNER" >{seen}'
    )
    run = subprocess.run(
        ["bash", str(ws.script), "--pg", "--", "bash", "-c", command],
        env=ws.env(),
        capture_output=True,
        text=True,
        timeout=STARTUP_SECONDS,
    )
    assert run.returncode == 0, run.stderr
    ws.volumes |= set(seen.read_text().split())
    assert ws.volumes, "运行期间容器应当挂着数据卷（前提不成立，这个检查什么也证明不了）"
    assert ws.containers() == []
    assert ws.leftover_volumes() == []


def test_an_interrupted_run_leaves_no_volume(ws: Workspace) -> None:
    """Ctrl-C：信号发给整个前台进程组，脚本退出时收尾的 trap 删容器和它的卷。"""
    proc, _, container = ws.start("sleep", "600")
    assert ws.volumes, "运行期间容器应当挂着数据卷（前提不成立，这个检查什么也证明不了）"
    os.killpg(proc.pid, signal.SIGINT)
    assert proc.wait(timeout=120) == 130
    assert container not in ws.containers()
    assert ws.containers() == []
    assert ws.leftover_volumes() == []


def test_clean_after_a_killed_run_removes_the_container_and_its_volume(ws: Workspace) -> None:
    """脚本被 SIGKILL 杀掉，收尾没有跑到：容器和卷还在，之后的 `pnpm heavy --clean` 全删掉。"""
    proc, _, container = ws.start("sleep", "600")
    assert ws.volumes, "运行期间容器应当挂着数据卷（前提不成立，这个检查什么也证明不了）"
    os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=30)
    # 杀掉之后收尾没有跑：容器和它的卷都还在（--clean 要处理的就是这种情形）。
    assert container in ws.containers()
    assert ws.leftover_volumes() == sorted(ws.volumes)

    clean = subprocess.run(
        ["bash", str(ws.script), "--clean"],
        env=ws.env(),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert clean.returncode == 0, clean.stderr
    assert ws.containers() == []
    assert ws.leftover_volumes() == []
