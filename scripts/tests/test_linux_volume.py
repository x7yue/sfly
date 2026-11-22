"""`pnpm linux` 的卷不会一直涨（#579）：清掉没有主人的工作区副本，编译结果有上限。

卷 `sfly-linux` 里每个工作区一个目录 `/vol/<工作区路径的哈希>/`（工作区副本 `work`、
编译结果 `target`、`files`、每次运行写下的 `root`）。工作区（git worktree）删掉之后，
这个目录没有人用，`pnpm linux --clean` 也只清当前工作区自己的，一天里攒出几个 GB。

清理的判断（`scripts/linux/prune.sh`，`pnpm linux --prune` 调它，每次运行前也自动调）
用一个临时卷测：先在卷里造几种目录——主人还在的、主人不在了的、没有记录路径的旧目录
和新目录、不是工作区副本的目录（共享缓存、别人手工放的）——清理之后，只有主人不在了的、
很久没用过又不知道主人的被删，其余原样。编译结果的上限（`scripts/linux/trim-target.sh`）
不需要 docker，在临时目录里测两级处理。

没有 docker 时清理的测试本地跳过；CI（设置了 CI）上必须有 docker，没有就失败，
不能悄悄不测。`run.sh` 整条运行要先构建好几 GB 的镜像，这里不跑；`entry.sh` 写下
`root`、调用 `trim-target.sh` 的几行在 PR 里用真实的卷核对过。"""

from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "scripts" / "linux"
PG_IMAGE = "postgres:18"
MIB = 1024 * 1024


def _docker(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


def _docker_usable() -> bool:
    if shutil.which("docker") is None:
        return False
    return _docker("info").returncode == 0


# ---- 编译结果的上限（不需要 docker） ----


def _fill(path: Path, mib: int) -> None:
    """写一个真有这么多字节的文件（稀疏文件在 du 里算 0）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(os.urandom(1024) * (mib * 1024))


def _trim(
    target: Path, limit_mb: int, *, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            str(LINUX / "trim-target.sh"),
            str(target),
            *([str(limit_mb)] if limit_mb else []),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )


def _tree(target: Path) -> set[str]:
    return {str(p.relative_to(target)) for p in target.rglob("*") if p.is_file()}


def test_a_target_under_the_limit_is_left_alone(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _fill(target / "debug" / "build" / "a.bin", 2)
    _fill(target / "debug" / "incremental" / "b.bin", 1)

    done = _trim(target, 10)

    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    assert _tree(target) == {"debug/build/a.bin", "debug/incremental/b.bin"}


def test_over_the_limit_the_incremental_caches_go_first_and_the_rest_stays(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _fill(target / "debug" / "build" / "a.bin", 2)
    _fill(target / "debug" / "incremental" / "b.bin", 3)
    _fill(target / "release" / "incremental" / "c.bin", 1)

    done = _trim(target, 4)

    assert done.returncode == 0, done.stderr
    assert _tree(target) == {"debug/build/a.bin"}
    assert "增量编译的缓存" in done.stderr
    assert "整个删掉" not in done.stderr


def test_still_over_the_limit_after_that_the_whole_target_goes(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _fill(target / "debug" / "build" / "a.bin", 5)
    _fill(target / "debug" / "incremental" / "b.bin", 1)

    done = _trim(target, 3)

    assert done.returncode == 0, done.stderr
    assert not target.exists()
    assert "整个删掉" in done.stderr
    assert "从头编译" in done.stderr


def test_a_target_exactly_at_the_limit_is_left_alone(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _fill(target / "debug" / "build" / "a.bin", 3)

    done = _trim(target, 3)

    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    assert _tree(target) == {"debug/build/a.bin"}


def test_the_limit_can_come_from_the_environment(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _fill(target / "debug" / "build" / "a.bin", 3)

    kept = _trim(target, 0, env={"SFLY_LINUX_TARGET_LIMIT_MB": "10"})
    assert kept.returncode == 0 and target.exists()
    removed = _trim(target, 0, env={"SFLY_LINUX_TARGET_LIMIT_MB": "1"})
    assert removed.returncode == 0 and not target.exists()


def test_a_missing_target_is_fine_and_dangerous_paths_are_refused(tmp_path: Path) -> None:
    assert _trim(tmp_path / "nope", 1).returncode == 0
    for bad in ("/", ".", ""):
        done = subprocess.run(
            ["bash", str(LINUX / "trim-target.sh"), bad, "1"], capture_output=True, text=True
        )
        assert done.returncode != 0, bad


# ---- 清掉没有主人的工作区副本（需要 docker） ----

NAME_ALIVE = "aaaaaaaaaaaa"
NAME_DEAD = "bbbbbbbbbbbb"
NAME_LEGACY_OLD = "cccccccccccc"
NAME_LEGACY_NEW = "dddddddddddd"
NAME_NOT_A_COPY = "eeeeeeeeeeee"
NAME_DEAD_ODD_PATH = "ffffffffffff"


@pytest.fixture(scope="module")
def docker_required() -> None:
    if _docker_usable():
        return
    if os.environ.get("CI"):
        pytest.fail("CI 上必须有 docker：这个测试守着 pnpm linux 的卷不会一直涨，不能悄悄跳过")
    pytest.skip("没有可用的 docker")


@pytest.fixture(scope="module")
def image(docker_required: None) -> str:
    # 第一次要拉镜像：CI 上的 runner 是干净的。
    pulled = _docker("pull", "--quiet", PG_IMAGE)
    assert pulled.returncode == 0, pulled.stderr
    return PG_IMAGE


@pytest.fixture
def alive_root(tmp_path: Path) -> Path:
    """主人还在的工作区：路径存在，里面有空格和汉字。"""
    root = tmp_path / "有 空格的工作区"
    root.mkdir()
    return root


@pytest.fixture
def volume(image: str, alive_root: Path, tmp_path: Path) -> Iterator[str]:
    """一个临时卷，里面各种目录各一个；用完删掉。"""
    name = f"sfly-linux-test-{uuid.uuid4().hex[:10]}"
    gone = tmp_path / "已经 删掉的工作区"  # 从来没建过：路径不存在
    script = f"""
set -e
cd /vol
make() {{ # 目录名 记录的路径（空 = 没有 root 文件） files 的修改时间（touch -d 的写法）
	mkdir -p "$1/work" "$1/target"
	head -c {2 * MIB} /dev/urandom > "$1/target/blob"
	: > "$1/files"
	if [ -n "$2" ]; then printf '%s' "$2" > "$1/root"; fi
	touch -d "$3" "$1/files"
}}
make {NAME_ALIVE} '{alive_root}' now
make {NAME_DEAD} '/nonexistent/sfly-worktree-gone' now
make {NAME_DEAD_ODD_PATH} '{gone}' now
make {NAME_LEGACY_OLD} '' '40 days ago'
make {NAME_LEGACY_NEW} '' now
# 不是工作区副本：名字像、但没有 work 和 files；共享缓存；别人手工放的目录
mkdir -p {NAME_NOT_A_COPY}/target cache/uv perf-1
head -c {MIB} /dev/urandom > cache/uv/blob
head -c {MIB} /dev/urandom > {NAME_NOT_A_COPY}/target/blob
: > perf-1/result
"""
    made = _docker(
        "run", "--rm", "-v", f"{name}:/vol", "--entrypoint", "sh", PG_IMAGE, "-c", script
    )
    assert made.returncode == 0, made.stderr
    try:
        yield name
    finally:
        _docker("volume", "rm", "-f", name)


def _entries(volume: str, image: str) -> set[str]:
    listed = _docker("run", "--rm", "-v", f"{volume}:/vol:ro", "--entrypoint", "ls", image, "/vol")
    assert listed.returncode == 0, listed.stderr
    return set(listed.stdout.split())


def _prune(volume: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(LINUX / "run.sh"), "--prune", *args],
        capture_output=True,
        text=True,
        env={**os.environ, "SFLY_LINUX_VOLUME": volume},
        cwd=ROOT,
    )


EVERYTHING = {
    NAME_ALIVE,
    NAME_DEAD,
    NAME_DEAD_ODD_PATH,
    NAME_LEGACY_OLD,
    NAME_LEGACY_NEW,
    NAME_NOT_A_COPY,
    "cache",
    "perf-1",
}


def test_only_copies_without_an_owner_are_removed(volume: str, image: str) -> None:
    assert _entries(volume, image) == EVERYTHING

    done = _prune(volume)

    assert done.returncode == 0, done.stderr
    # 主人不在了的两个（路径不存在，含空格和汉字的那个也是），和没有记录路径、
    # 40 天没动过的那个删了；主人还在的、没有记录路径但刚用过的、不是工作区副本的、
    # 共享缓存、别人手工放的，原样。
    assert _entries(volume, image) == {
        NAME_ALIVE,
        NAME_LEGACY_NEW,
        NAME_NOT_A_COPY,
        "cache",
        "perf-1",
    }
    # 说明里写明清了几个、各是什么、为什么、多大。
    assert "清理了 3 个" in done.stderr
    for name in (NAME_DEAD, NAME_DEAD_ODD_PATH, NAME_LEGACY_OLD):
        assert name in done.stderr
    assert "已经不存在" in done.stderr
    assert "没有记录工作区路径" in done.stderr
    assert "GB" in done.stderr
    for name in (NAME_ALIVE, NAME_LEGACY_NEW, NAME_NOT_A_COPY):
        assert name not in done.stderr


def test_dry_run_lists_what_would_go_and_removes_nothing(volume: str, image: str) -> None:
    done = _prune(volume, "--dry-run")

    assert done.returncode == 0, done.stderr
    assert _entries(volume, image) == EVERYTHING
    assert "会清理 3 个" in done.stderr
    assert "没有删" in done.stderr
    for name in (NAME_DEAD, NAME_DEAD_ODD_PATH, NAME_LEGACY_OLD):
        assert name in done.stderr


def test_a_second_prune_has_nothing_left_to_do(volume: str, image: str) -> None:
    assert _prune(volume).returncode == 0

    again = _prune(volume)

    assert again.returncode == 0, again.stderr
    assert "没有要清理的" in again.stderr


def test_quiet_says_nothing_when_there_is_nothing_to_do(volume: str, image: str) -> None:
    assert _prune(volume).returncode == 0

    done = subprocess.run(
        ["bash", str(LINUX / "prune.sh"), volume, image, "--quiet"], capture_output=True, text=True
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout == "" and done.stderr == ""


def test_the_kept_workspace_is_never_removed_even_if_its_path_is_gone(
    volume: str, image: str
) -> None:
    done = subprocess.run(
        ["bash", str(LINUX / "prune.sh"), volume, image, "--keep", NAME_DEAD],
        capture_output=True,
        text=True,
    )

    assert done.returncode == 0, done.stderr
    entries = _entries(volume, image)
    assert NAME_DEAD in entries  # 当前正在用的工作区
    assert NAME_DEAD_ODD_PATH not in entries


def test_the_stale_threshold_can_be_changed(volume: str, image: str) -> None:
    done = subprocess.run(
        ["bash", str(LINUX / "prune.sh"), volume, image],
        capture_output=True,
        text=True,
        env={**os.environ, "SFLY_LINUX_STALE_DAYS": "60"},
    )

    assert done.returncode == 0, done.stderr
    # 40 天没动过，阈值改成 60 天：留下。
    assert NAME_LEGACY_OLD in _entries(volume, image)


def test_a_copy_used_between_listing_and_deleting_is_not_removed(
    volume: str, image: str, tmp_path: Path
) -> None:
    """列出之后、删之前有人用了这个没有记录路径的旧副本（files 的时间更新了）：不删。

    用一个转发给真 docker 的假 docker：看到删除那一步的容器启动之前，先把旧副本的 files 碰一下。"""
    real = shutil.which("docker")
    assert real is not None
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "docker").write_text(
        f"""#!/usr/bin/env bash
if [[ $1 == run && "$*" == *"rm -rf"* && "$*" == *"{volume}:/vol "* ]]; then
	{real} run --rm -v {volume}:/vol --entrypoint touch {image} /vol/{NAME_LEGACY_OLD}/files
fi
exec {real} "$@"
""",
        encoding="utf-8",
    )
    (shim / "docker").chmod(0o755)

    done = subprocess.run(
        ["bash", str(LINUX / "prune.sh"), volume, image],
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": f"{shim}:{os.environ['PATH']}"},
    )

    assert done.returncode == 0, done.stderr
    entries = _entries(volume, image)
    assert NAME_LEGACY_OLD in entries  # 刚被用过：留下
    assert NAME_DEAD not in entries  # 主人不在了的照常删
    assert NAME_DEAD_ODD_PATH not in entries


def test_a_volume_that_does_not_exist_is_not_created(image: str) -> None:
    name = f"sfly-linux-test-{uuid.uuid4().hex[:10]}"

    done = _prune(name)

    assert done.returncode == 0, done.stderr
    assert _docker("volume", "inspect", name).returncode != 0
