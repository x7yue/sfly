"""调用 docker 命令行的薄封装：命令失败时带上 stderr 的末尾抛出，便于定位。"""

from __future__ import annotations

import subprocess
from collections.abc import Mapping, Sequence


class DockerError(RuntimeError):
    pass


def docker(
    *args: str,
    check: bool = True,
    input_text: str | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", *args],
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-15:]
        raise DockerError(
            f"docker {' '.join(args[:3])} … 退出码 {result.returncode}\n" + "\n".join(tail)
        )
    return result


def exists(kind: str, name: str) -> bool:
    return docker(kind, "inspect", name, check=False).returncode == 0


def container_running(name: str) -> bool:
    result = docker("inspect", "--format", "{{.State.Running}}", name, check=False)
    return result.returncode == 0 and result.stdout.strip() == "true"


def sh(
    container: str,
    script: str,
    *,
    env: Mapping[str, str] | None = None,
    workdir: str | None = None,
    check: bool = True,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """在容器里用 bash 执行一段脚本（以 root、登录 shell 的 PATH 运行）。"""
    args: list[str] = ["exec", "-i"]
    for key, value in (env or {}).items():
        args += ["-e", f"{key}={value}"]
    if workdir:
        args += ["-w", workdir]
    args += [container, "bash", "-lc", script]
    return docker(*args, check=check, timeout=timeout)


def detach(container: str, argv: Sequence[str]) -> None:
    docker("exec", "-d", container, *argv)


def copy_in(src: str, container: str, dest: str) -> None:
    docker("cp", src, f"{container}:{dest}")


def copy_out(container: str, src: str, dest: str, check: bool = True) -> bool:
    return docker("cp", f"{container}:{src}", dest, check=check).returncode == 0
