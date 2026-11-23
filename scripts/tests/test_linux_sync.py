"""`pnpm linux` 把工作区同步进卷里的副本时，内容变了的文件修改时间变成现在（#589）。

cargo 按修改时间判断要不要重编。同步用 `rsync -a` 时修改时间跟着宿主走：卷里的源文件被改过
（例如在容器里做变异），或者宿主上换了内容而修改时间比卷里的更早，同步换回了内容、修改时间
却变得更早，cargo 看到源文件比已有的编译结果还早，就接着用旧的二进制，测试跑的不是眼前这份源码，
而且没有任何提示。

`scripts/linux/sync-copy.sh` 是 `entry.sh` 里复制那一步（`--no-times --checksum`）：这里直接在宿主上
用真的 rsync 跑它，不需要 docker。没有 rsync 时本地跳过；CI（设置了 CI）上必须有，没有就失败，
不能悄悄不测。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "scripts" / "linux"
LONG_AGO = 1_500_000_000  # 2017 年：比任何文件的「现在」都早
SECOND = 1.0


@pytest.fixture(autouse=True)
def rsync_required() -> None:
    if shutil.which("rsync"):
        return
    if os.environ.get("CI"):
        pytest.fail("CI 上必须有 rsync：这个测试守着 pnpm linux 同步后 cargo 会重编，不能悄悄跳过")
    pytest.skip("没有 rsync")


class Sync:
    """一次同步：宿主上的源目录、清单、卷里的副本。"""

    def __init__(self, base: Path) -> None:
        self.src = base / "src"
        self.dest = base / "dest"
        self.src.mkdir()
        self.dest.mkdir()
        self.listing = base / "files"

    def write_src(self, name: str, text: str, mtime: float | None = None) -> None:
        path = self.src / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))

    def write_dest(self, name: str, text: str, mtime: float | None = None) -> None:
        path = self.dest / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))

    def run(self, names: list[str]) -> subprocess.CompletedProcess[str]:
        self.listing.write_bytes(b"".join(name.encode() + b"\0" for name in names))
        return subprocess.run(
            ["bash", str(LINUX / "sync-copy.sh"), str(self.src), str(self.listing), str(self.dest)],
            capture_output=True,
            text=True,
        )

    def mtime(self, name: str) -> float:
        return (self.dest / name).stat().st_mtime

    def text(self, name: str) -> str:
        return (self.dest / name).read_text(encoding="utf-8")


@pytest.fixture
def sync(tmp_path: Path) -> Sync:
    return Sync(tmp_path)


def test_a_file_changed_on_the_host_gets_the_new_content_and_a_modification_time_of_now(
    sync: Sync,
) -> None:
    """宿主上的文件换了内容、修改时间比卷里的更早：同步之后内容一致，修改时间不早于之前卷里的。"""
    built = time.time() - 3600  # 卷里的副本一小时前同步过、编译过
    sync.write_dest("src/lib.rs", "old\n", mtime=built)
    sync.write_src("src/lib.rs", "new\n", mtime=LONG_AGO)

    done = sync.run(["src/lib.rs"])

    assert done.returncode == 0, done.stderr
    assert sync.text("src/lib.rs") == "new\n"
    assert sync.mtime("src/lib.rs") >= built, "修改时间被还原成宿主上更早的那个：cargo 不会重编"
    assert sync.mtime("src/lib.rs") >= time.time() - 60 * SECOND, "写过的文件修改时间应该是现在"


def test_a_file_changed_in_the_volume_is_put_back_and_looks_newer_than_before(sync: Sync) -> None:
    """卷里的文件被改过（容器里做变异，修改时间比宿主新）：同步之后内容和宿主一致，修改时间不早于之前。"""
    mutated_at = time.time() - 120
    sync.write_src("a.rs", "original\n", mtime=LONG_AGO)
    sync.write_dest("a.rs", "mutated\n", mtime=mutated_at)

    done = sync.run(["a.rs"])

    assert done.returncode == 0, done.stderr
    assert sync.text("a.rs") == "original\n"
    assert sync.mtime("a.rs") >= mutated_at


def test_a_file_whose_content_did_not_change_is_left_alone(sync: Sync) -> None:
    """内容没变的文件不动、修改时间不变：不然每次同步 cargo 都整个重编。"""
    built = time.time() - 3600
    for name in ("a.rs", "b.rs"):
        sync.write_src(name, f"{name}\n", mtime=LONG_AGO)
        sync.write_dest(name, f"{name}\n", mtime=built)

    done = sync.run(["a.rs", "b.rs"])

    assert done.returncode == 0, done.stderr
    assert sync.mtime("a.rs") == pytest.approx(built, abs=1)
    assert sync.mtime("b.rs") == pytest.approx(built, abs=1)


def test_only_the_changed_file_gets_a_new_time_among_unchanged_ones(sync: Sync) -> None:
    built = time.time() - 3600
    for name in ("a.rs", "b.rs", "c.rs"):
        sync.write_src(name, f"{name}\n", mtime=LONG_AGO)
        sync.write_dest(name, f"{name}\n", mtime=built)
    sync.write_src("b.rs", "b changed\n", mtime=LONG_AGO)

    assert sync.run(["a.rs", "b.rs", "c.rs"]).returncode == 0

    assert sync.mtime("a.rs") == pytest.approx(built, abs=1)
    assert sync.mtime("c.rs") == pytest.approx(built, abs=1)
    assert sync.mtime("b.rs") >= time.time() - 60 * SECOND
    assert sync.text("b.rs") == "b changed\n"


def test_a_new_file_is_copied_with_a_modification_time_of_now(sync: Sync) -> None:
    sync.write_src("sub/dir/new.rs", "fresh\n", mtime=LONG_AGO)

    assert sync.run(["sub/dir/new.rs"]).returncode == 0

    assert sync.text("sub/dir/new.rs") == "fresh\n"
    assert sync.mtime("sub/dir/new.rs") >= time.time() - 60 * SECOND


def test_same_size_different_content_is_still_noticed(sync: Sync) -> None:
    """只比大小和修改时间会漏掉「内容不同、大小相同」的改动（变异常常只改一个字符）：按内容判断。"""
    built = time.time() - 3600
    sync.write_src("a.rs", "x = 1\n", mtime=built)
    sync.write_dest("a.rs", "x = 2\n", mtime=built)

    assert sync.run(["a.rs"]).returncode == 0

    assert sync.text("a.rs") == "x = 1\n"
    assert sync.mtime("a.rs") >= built


def test_only_the_listed_files_are_copied_and_the_rest_of_the_destination_is_untouched(
    sync: Sync,
) -> None:
    """清单之外的文件（容器里生成的 node_modules、.venv）不碰；源目录里没列出的文件也不复制。"""
    sync.write_src("listed.rs", "yes\n")
    sync.write_src("unlisted.rs", "no\n")
    sync.write_dest("node_modules/x/index.js", "generated\n", mtime=LONG_AGO)

    assert sync.run(["listed.rs"]).returncode == 0

    assert sync.text("listed.rs") == "yes\n"
    assert not (sync.dest / "unlisted.rs").exists()
    assert sync.text("node_modules/x/index.js") == "generated\n"
    assert sync.mtime("node_modules/x/index.js") == pytest.approx(LONG_AGO, abs=1)


def test_names_with_spaces_and_chinese_characters_are_copied(sync: Sync) -> None:
    name = "docs/有 空格 的 文档.md"
    sync.write_src(name, "内容\n", mtime=LONG_AGO)

    assert sync.run([name]).returncode == 0

    assert sync.text(name) == "内容\n"


def test_a_failure_is_reported_not_swallowed(tmp_path: Path) -> None:
    sync = Sync(tmp_path)

    done = sync.run(["no-such-file.rs"])

    assert done.returncode != 0


def test_entry_sh_copies_through_the_script_and_no_longer_calls_rsync_itself() -> None:
    text = (LINUX / "entry.sh").read_text(encoding="utf-8")
    code = [line for line in text.splitlines() if not line.lstrip().startswith("#")]

    assert any("scripts/linux/sync-copy.sh" in line and "/sync/files" in line for line in code)
    assert not any(line.lstrip().startswith("rsync") for line in code), (
        "entry.sh 里不要再直接 rsync"
    )


def test_the_script_uses_no_times_and_checksum() -> None:
    """两个选项缺一个都会坏：少了 --no-times 修改时间被还原，少了 --checksum 每次重写全部文件。"""
    text = (LINUX / "sync-copy.sh").read_text(encoding="utf-8")
    command = next(line for line in text.splitlines() if line.startswith("rsync "))

    assert "--no-times" in command
    assert "--checksum" in command
