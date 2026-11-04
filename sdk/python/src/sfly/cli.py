"""sfly 命令行入口。子命令（build / publish / dev）由后续票据加入。"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from sfly import __version__


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sfly", description="sfly 节点包开发工具")
    parser.add_argument("--version", action="version", version=f"sfly {__version__}")
    parser.parse_args(argv)
    parser.print_help()
    return 0
