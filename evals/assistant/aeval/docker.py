"""调用 docker 命令行的薄封装：命令失败时带上 stderr 的末尾抛出，便于定位。"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence


class DockerError(RuntimeError):
    pass


def docker(
    *args: str,
    check: bool = True,
    input_text: str | None = None,
    timeout: float | None = None,
    env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """`env`：加给 docker 命令行进程的环境变量。secret 值用它，配合参数里只写名字的 `-e 名字`：
    值不出现在命令行参数里（`ps` 看得到参数），出错时也不会被带进异常。"""
    result = subprocess.run(
        ["docker", *args],
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, **env} if env else None,
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
    secret_env: Mapping[str, str] | None = None,
    input_text: str | None = None,
    workdir: str | None = None,
    check: bool = True,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """在容器里用 bash 执行一段脚本（以 root、登录 shell 的 PATH 运行）。

    secret 值（凭据）不要放进命令行参数（宿主机上 `ps` 看得到参数）：环境变量用 `secret_env`
    （参数里只写 `-e 名字`，值经 docker 命令行进程的环境带进去），
    别的用 `input_text` 经标准输入给脚本。
    """
    args: list[str] = ["exec", "-i"]
    for key, value in (env or {}).items():
        args += ["-e", f"{key}={value}"]
    for key in secret_env or {}:
        args += ["-e", key]
    if workdir:
        args += ["-w", workdir]
    args += [container, "bash", "-lc", script]
    return docker(*args, check=check, timeout=timeout, input_text=input_text, env=secret_env)


def detach(container: str, argv: Sequence[str]) -> None:
    docker("exec", "-d", container, *argv)


def copy_in(src: str, container: str, dest: str) -> None:
    docker("cp", src, f"{container}:{dest}")


def copy_out(container: str, src: str, dest: str, check: bool = True) -> bool:
    return docker("cp", f"{container}:{src}", dest, check=check).returncode == 0
