"""`--project` 改名 `--package-dir`（ADR 0029，#491）：「项目」这个词留给多项目的租户。

`sfly debug`、`sfly skill update` 的 `--package-dir` 指节点包目录；
旧名 `--project` 这个版本还能用，用到时在 stderr 提示一次；
`build`、`dev` 的位置参数在帮助里叫「节点包目录」。同一个版本里 `--project` 不表示别的意思。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sfly.cli import main


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def help_text(capsys: pytest.CaptureFixture[str], *argv: str) -> str:
    with pytest.raises(SystemExit) as caught:
        main([*argv, "--help"])
    assert caught.value.code == 0
    return capsys.readouterr().out


class TestSkillUpdate:
    def test_package_dir_points_at_the_directory_without_a_notice(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, _, err = run(capsys, "skill", "update", "--package-dir", str(tmp_path))
        # 这个目录不是节点包目录（没有 pyproject.toml）：退出码 2，说明里写的是新名。
        assert code == 2
        assert "--package-dir" in err and "节点包目录" in err
        assert "--project" not in err
        assert "已改名" not in err

    def test_the_old_name_still_works_and_says_it_was_renamed_once(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, _, err = run(capsys, "skill", "update", "--project", str(tmp_path))
        assert code == 2
        assert err.count("--project 已改名为 --package-dir") == 1
        assert "旧名这个版本还能用" in err
        # 旧名和新名指向同一个目录：找不到 pyproject.toml 的位置是同一个。
        assert str(tmp_path / "pyproject.toml") in err

    def test_giving_both_uses_the_last_one(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        other = tmp_path / "other"
        other.mkdir()
        code, _, err = run(
            capsys, "skill", "update", "--package-dir", str(other), "--project", str(tmp_path)
        )
        assert code == 2
        assert str(tmp_path / "pyproject.toml") in err
        assert str(other / "pyproject.toml") not in err


class TestDebug:
    def test_both_names_find_the_package_directory(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # 目录里没有节点包：debug 报「扫描节点失败」之类的错误，退出码不是 0；
        # 要紧的是两个名字都被认得（argparse 不报 unrecognized arguments），并且指向这个目录。
        for option in ("--package-dir", "--project"):
            code, _, err = run(capsys, "debug", "ping", option, str(tmp_path), "--params", "{}")
            assert code != 0
            assert "unrecognized" not in err
            if option == "--project":
                assert err.count("--project 已改名为 --package-dir") == 1
            else:
                assert "已改名" not in err


class TestHelp:
    def test_debug_and_skill_update_document_the_new_name_and_the_old_one(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        for argv in (("debug",), ("skill", "update")):
            text = help_text(capsys, *argv)
            assert "--package-dir" in text
            assert "节点包目录" in text
            # 旧名还在帮助里，说明是旧名、下个版本起另有用途。
            assert "--project" in text
            assert "旧名" in text
            assert "下个版本起 --project 用来选项目" in text

    def test_build_and_dev_call_their_positional_argument_the_package_directory(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        for command in ("build", "dev"):
            text = help_text(capsys, command)
            assert "节点包目录" in text
            assert "项目目录" not in text

    def test_build_still_takes_the_directory_positionally(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, _, err = run(capsys, "build", str(tmp_path))
        # 空目录构建失败（没有 pyproject.toml），但位置参数被认得。
        assert code == 1
        assert "unrecognized" not in err
        assert "构建失败" in err
