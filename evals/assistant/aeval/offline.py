"""离线包：把评测要用的镜像、评测目录和镜像站的缓存打成一个目录（再 tar 成一个文件），
带到不能联网的环境里，对那里的模型跑同样的评测、输出同样格式的结果。

包里有：
- `images.tar`：控制面、PostgreSQL、工作台、臂 B 的 pi、加固工作台（`probe` 用）五个镜像；
- `evals/`：这个评测目录里被 git 跟踪的文件（命令、题目、判分），
  加上两份 skill 的副本（`vendor/skills/`）；
- `mirror-cache/`：镜像站的缓存（uv、Python、`sfly init` 项目和节点包要的 PyPI 包）。
  要在联网的环境里把每道题至少跑过一遍（`selfcheck` 就会），缓存才是全的。
- `MANIFEST.json`：镜像名、sfly 和 pi 的版本、生成时间。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from aeval import docker as d
from aeval import probe
from aeval.env import EVALS_DIR, POSTGRES_IMAGE, Stack


def copy_tracked(dest: Path) -> list[str]:
    """只复制评测目录里被 git 跟踪的文件：被 .gitignore 挡掉的（本机的缓存、日志）不进离线包，
    离线包里有的就是干净的检出里有的。"""
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "."], cwd=EVALS_DIR, capture_output=True, check=True
    )
    files = [f for f in out.stdout.decode().split("\0") if f]
    for relative in files:
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(EVALS_DIR / relative, target)
    return files


def pack(stack: Stack, out_dir: Path, say: Callable[[str], None] = print) -> Path:
    name = f"sfly-aeval-offline-{datetime.now().strftime('%Y%m%d-%H%M')}"
    root = out_dir / name
    root.mkdir(parents=True)
    pi = d.docker("run", "--rm", stack.workbench_image, "pi", "--version").stdout.strip()
    stack.ensure_remote_image(say)
    probe.ensure_image(stack)
    images = [
        stack.server_image,
        POSTGRES_IMAGE,
        stack.workbench_image,
        stack.remote_image,
        probe.image(stack),
    ]
    say(f"保存镜像：{'、'.join(images)}")
    d.docker("save", "-o", str(root / "images.tar"), *images, timeout=3600)
    say("复制评测目录和镜像站缓存")
    copy_tracked(root / "evals")
    # probe 要用两份 skill 的源文件，离线包里没有仓库：带一份副本。
    shutil.copytree(probe.skills_source(), root / "evals" / "vendor" / "skills")
    shutil.copytree(stack.cache_dir, root / "mirror-cache")
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "server_image": stack.server_image,
        "postgres_image": POSTGRES_IMAGE,
        "workbench_image": stack.workbench_image,
        "pi": pi,
    }
    (root / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    archive = out_dir / f"{name}.tar"
    say(f"打包成 {archive}")
    subprocess.run(["tar", "-cf", str(archive), "-C", str(out_dir), name], check=True)
    shutil.rmtree(root)
    return archive
